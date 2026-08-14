import {
  McpHttpError,
  McpSessionExpiredError,
  type JsonRpcMessage,
  type McpTransport,
} from "./client";
import { readSseEvents } from "./sse";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type StreamableHttpMcpTransportOptions = {
  url: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  authorization?: () => Promise<string | undefined>;
  reconnection?: Partial<StreamableHttpReconnectionOptions>;
};

export type StreamableHttpReconnectionOptions = {
  initialDelayMs: number;
  maximumDelayMs: number;
  growFactor: number;
  maximumRetries: number;
};

export const STREAMABLE_HTTP_RECONNECTION_DEFAULTS: StreamableHttpReconnectionOptions = {
  initialDelayMs: 1_000,
  maximumDelayMs: 30_000,
  growFactor: 1.5,
  maximumRetries: 2,
};

export class StreamableHttpMcpTransport implements McpTransport {
  readonly supportsModernProtocolProbe = true;
  private readonly fetcher: FetchLike;
  private receive?: (message: JsonRpcMessage) => void;
  private onError: ((error: Error) => void) | undefined;
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private readonly active = new Map<string | number, AbortController>();
  private listenController: AbortController | undefined;
  private streamTask: Promise<void> | undefined;
  private lastEventId: string | undefined;
  private serverRetryMs: number | undefined;
  private closed = false;
  private readonly toolHeaders = new Map<string, ToolHeaderDefinition[]>();
  private readonly reconnection: StreamableHttpReconnectionOptions;

  constructor(private readonly options: StreamableHttpMcpTransportOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.reconnection = {
      ...STREAMABLE_HTTP_RECONNECTION_DEFAULTS,
      ...options.reconnection,
    };
  }

  async start(
    receive: (message: JsonRpcMessage) => void,
    onError?: (error: Error) => void,
  ): Promise<void> {
    if (this.closed) throw new Error("MCP HTTP transport is closed");
    this.receive = receive;
    this.onError = onError;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.receive) throw new Error("MCP HTTP transport is not started");
    this.abortCancelledRequest(message);
    const controller = new AbortController();
    const requestHadSession = this.sessionId !== undefined;
    if ("id" in message) this.active.set(message.id, controller);
    try {
      const response = await this.fetcher(this.options.url, {
        method: "POST",
        headers: await this.requestHeaders(message),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        if (response.status === 404 && requestHadSession) {
          this.expireSession();
          throw new McpSessionExpiredError();
        }
        const error = parseJsonRpcError(body);
        if (error) {
          this.receive(error);
          return;
        }
        throw new McpHttpError(response.status, body);
      }
      if ("id" in message) {
        await this.readResponse(
          response,
          "method" in message && message.method === "initialize",
          "method" in message && message.method === "subscriptions/listen",
        );
      } else if (response.status !== 202 && response.body) {
        await this.readResponse(response, false);
      }
      if ("method" in message && message.method === "notifications/initialized") {
        this.startServerStream();
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (!controller.signal.aborted) this.onError?.(normalized);
      throw normalized;
    } finally {
      if ("id" in message) this.active.delete(message.id);
    }
  }

  registerToolDefinitions(tools: import("./client").McpToolDefinition[]): import("./client").McpToolDefinition[] {
    this.toolHeaders.clear();
    const valid = [];
    for (const tool of tools) {
      try {
        this.toolHeaders.set(tool.name, collectToolHeaders(tool.inputSchema));
        valid.push(tool);
      } catch {
        // The 2026-07-28 transport requires clients to exclude malformed
        // x-mcp-header definitions instead of allowing one tool to break discovery.
      }
    }
    return valid;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listenController?.abort();
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    await this.streamTask?.catch(() => undefined);
    if (!this.sessionId) return;
    const response = await this.fetcher(this.options.url, {
      method: "DELETE",
      headers: await this.requestHeaders(),
    });
    this.clearSessionMetadata();
    if (!response.ok && response.status !== 405) {
      throw new Error(`MCP HTTP session deletion failed (${response.status})`);
    }
  }

  private async requestHeaders(message?: JsonRpcMessage): Promise<Headers> {
    const headers = new Headers(this.options.headers);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json, text/event-stream");
    if (this.sessionId) headers.set("MCP-Session-Id", this.sessionId);
    const modernVersion = requestProtocolVersion(message);
    if (modernVersion) {
      headers.set("MCP-Protocol-Version", modernVersion);
      if (message && "method" in message) {
        headers.set("Mcp-Method", message.method);
        const name = requestName(message);
        if (name !== undefined) headers.set("Mcp-Name", encodeHeaderValue(name));
        if (message.method === "tools/call") this.applyToolHeaders(headers, message);
      }
    } else if (this.protocolVersion) {
      headers.set("MCP-Protocol-Version", this.protocolVersion);
    }
    const token = await this.options.authorization?.();
    if (token) headers.set("authorization", `Bearer ${token}`);
    return headers;
  }

  private applyToolHeaders(
    headers: Headers,
    message: Extract<JsonRpcMessage, { method: string }>,
  ): void {
    if (typeof message.params !== "object" || message.params === null) return;
    const params = message.params as { name?: unknown; arguments?: unknown };
    if (typeof params.name !== "string") return;
    const definitions = this.toolHeaders.get(params.name) ?? [];
    for (const definition of definitions) {
      const value = valueAtPath(params.arguments, definition.path);
      if (value === undefined || value === null) continue;
      headers.set(`Mcp-Param-${definition.header}`, encodeHeaderValue(headerString(value, definition.type)));
    }
  }

  private startServerStream(): void {
    if (this.streamTask || this.closed) return;
    const controller = new AbortController();
    this.listenController = controller;
    const task = this.consumeServerStream(controller.signal);
    this.streamTask = task;
    void task.catch((error) => {
      if (error instanceof McpSessionExpiredError || !controller.signal.aborted) {
        this.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }).finally(() => {
      if (this.streamTask === task) this.streamTask = undefined;
      if (this.listenController === controller) this.listenController = undefined;
    });
  }

  private async consumeServerStream(signal: AbortSignal): Promise<void> {
    let failedAttempts = 0;
    while (!signal.aborted) {
      try {
        const reconnect = await this.consumeServerStreamOnce(signal);
        if (!reconnect || signal.aborted) return;
        failedAttempts = 0;
      } catch (error) {
        if (signal.aborted && !(error instanceof McpSessionExpiredError)) return;
        if (error instanceof McpSessionExpiredError) throw error;
        if (failedAttempts >= this.reconnection.maximumRetries) throw error;
        failedAttempts += 1;
      }
      await abortableDelay(this.reconnectionDelay(failedAttempts - 1), signal);
    }
  }

  private async consumeServerStreamOnce(signal: AbortSignal): Promise<boolean> {
    const requestHadSession = this.sessionId !== undefined;
    const headers = await this.serverStreamHeaders();
    const response = await this.fetcher(this.options.url, { method: "GET", headers, signal });
    if (response.status === 405) return false;
    if (response.status === 404 && requestHadSession) {
      await response.body?.cancel().catch(() => undefined);
      this.expireSession();
      throw new McpSessionExpiredError();
    }
    if (!response.ok) {
      throw new Error(`MCP HTTP server stream failed (${response.status}): ${await response.text()}`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "text/event-stream") {
      throw new Error(`MCP HTTP server stream returned ${contentType ?? "no content type"}`);
    }
    if (!response.body) throw new Error("MCP HTTP server stream returned no response body");
    for await (const event of readSseEvents(response.body.getReader())) {
      this.captureSseMetadata(event);
      if (event.data && (!event.event || event.event === "message")) {
        this.receive?.(parseMessage(JSON.parse(event.data)));
      }
    }
    return true;
  }

  private async readResponse(
    response: Response,
    initializing: boolean,
    deliverWhileStreaming = false,
  ): Promise<void> {
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    let messages: JsonRpcMessage[];
    if (initializing) this.captureInitializationHeaders(response);
    if (contentType === "application/json") {
      messages = [parseMessage(await response.json())];
    } else if (contentType === "text/event-stream") {
      if (!response.body) throw new Error("MCP HTTP SSE response returned no response body");
      messages = [];
      for await (const event of readSseEvents(response.body.getReader())) {
        this.captureSseMetadata(event);
        if (event.data && (!event.event || event.event === "message")) {
          const message = parseMessage(JSON.parse(event.data));
          if (deliverWhileStreaming) this.receive?.(message);
          else messages.push(message);
        }
      }
    } else {
      throw new Error(`Unsupported MCP HTTP response content type: ${contentType ?? "missing"}`);
    }
    if (messages.length === 0 && !deliverWhileStreaming) {
      throw new Error("MCP HTTP request returned no JSON-RPC response");
    }
    if (initializing) {
      const initializeResponse = messages.find(
        (message) => "id" in message && !('method' in message) && "result" in message,
      );
      if (initializeResponse && "result" in initializeResponse) {
        const result = initializeResponse.result;
        if (typeof result === "object" && result !== null && !Array.isArray(result)) {
          const version = (result as { protocolVersion?: unknown }).protocolVersion;
          if (typeof version === "string") this.protocolVersion = version;
        }
      }
    }
    if (!deliverWhileStreaming) {
      for (const message of messages) this.receive?.(message);
    }
  }

  private captureInitializationHeaders(response: Response): void {
    const sessionId = response.headers.get("MCP-Session-Id");
    if (!sessionId) return;
    if (!/^[\x21-\x7e]+$/.test(sessionId)) {
      throw new Error("MCP HTTP session id contains invalid characters");
    }
    this.sessionId = sessionId;
  }

  private captureSseMetadata(event: { id?: string; retry?: number }): void {
    if (event.id !== undefined) this.lastEventId = event.id || undefined;
    if (event.retry !== undefined) this.serverRetryMs = event.retry;
  }

  private async serverStreamHeaders(): Promise<Headers> {
    const headers = await this.requestHeaders();
    headers.delete("content-type");
    headers.set("accept", "text/event-stream");
    if (this.lastEventId) headers.set("last-event-id", this.lastEventId);
    return headers;
  }

  private reconnectionDelay(attempt: number): number {
    if (this.serverRetryMs !== undefined) return this.serverRetryMs;
    return Math.min(
      this.reconnection.initialDelayMs * this.reconnection.growFactor ** attempt,
      this.reconnection.maximumDelayMs,
    );
  }

  private expireSession(): void {
    this.listenController?.abort();
    this.streamTask = undefined;
    this.listenController = undefined;
    this.clearSessionMetadata();
  }

  private clearSessionMetadata(): void {
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    this.lastEventId = undefined;
    this.serverRetryMs = undefined;
  }

  private abortCancelledRequest(message: JsonRpcMessage): void {
    if (!("method" in message) || message.method !== "notifications/cancelled") return;
    const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId;
    if (typeof requestId === "string" || typeof requestId === "number") {
      this.active.get(requestId)?.abort();
    }
  }
}

function requestProtocolVersion(message?: JsonRpcMessage): string | undefined {
  if (!message || !("method" in message) || typeof message.params !== "object" || message.params === null) {
    return undefined;
  }
  const meta = (message.params as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  const version = (meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"];
  return typeof version === "string" ? version : undefined;
}

function requestName(message: Extract<JsonRpcMessage, { method: string }>): string | undefined {
  if (!['tools/call', 'resources/read', 'prompts/get', 'tasks/get', 'tasks/update', 'tasks/cancel'].includes(message.method)) return undefined;
  if (typeof message.params !== "object" || message.params === null) return undefined;
  const params = message.params as { name?: unknown; uri?: unknown };
  const value = message.method.startsWith("tasks/")
    ? (params as { taskId?: unknown }).taskId
    : message.method === "resources/read"
      ? params.uri
      : params.name;
  return typeof value === "string" ? value : undefined;
}

function encodeHeaderValue(value: string): string {
  const plain = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value) &&
    !(value.startsWith("=?base64?") && value.endsWith("?="));
  return plain
    ? value
    : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

type ToolHeaderDefinition = {
  header: string;
  path: string[];
  type: "string" | "integer" | "boolean";
};

function collectToolHeaders(schema: Record<string, unknown>): ToolHeaderDefinition[] {
  const result: ToolHeaderDefinition[] = [];
  const names = new Set<string>();
  visitSchema(schema, [], true, result, names);
  return result;
}

function visitSchema(
  schema: Record<string, unknown>,
  path: string[],
  reachable: boolean,
  result: ToolHeaderDefinition[],
  names: Set<string>,
): void {
  if ("x-mcp-header" in schema) {
    const header = schema["x-mcp-header"];
    const type = schema.type;
    if (!reachable || path.length === 0) throw new Error("x-mcp-header is not statically reachable");
    if (typeof header !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header)) {
      throw new Error("x-mcp-header is not a valid HTTP token");
    }
    if (type !== "string" && type !== "integer" && type !== "boolean") {
      throw new Error("x-mcp-header requires a string, integer, or boolean property");
    }
    const normalized = header.toLowerCase();
    if (names.has(normalized)) throw new Error("x-mcp-header names must be unique");
    names.add(normalized);
    result.push({ header, path, type });
  }
  for (const [keyword, value] of Object.entries(schema)) {
    if (keyword === "properties" && isRecord(value)) {
      for (const [name, child] of Object.entries(value)) {
        if (isRecord(child)) visitSchema(child, [...path, name], reachable, result, names);
      }
    } else if (isRecord(value)) {
      visitSchema(value, path, false, result, names);
    } else if (Array.isArray(value)) {
      for (const child of value) {
        if (isRecord(child)) visitSchema(child, path, false, result, names);
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAtPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current) || !(key in current)) return undefined;
    current = current[key];
  }
  return current;
}

function headerString(value: unknown, type: ToolHeaderDefinition["type"]): string {
  if (type === "string" && typeof value === "string") return value;
  if (type === "boolean" && typeof value === "boolean") return String(value);
  if (type === "integer" && Number.isSafeInteger(value)) return String(value);
  throw new Error(`MCP tool header value does not match declared ${type} type`);
}

function parseJsonRpcError(body: string): JsonRpcMessage | undefined {
  try {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value) || value.jsonrpc !== "2.0" || !isRecord(value.error)) return undefined;
    if (typeof value.error.code !== "number" || typeof value.error.message !== "string") return undefined;
    return value as JsonRpcMessage;
  } catch {
    return undefined;
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function parseMessage(value: unknown): JsonRpcMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("MCP HTTP server emitted a non-object JSON-RPC message");
  }
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") throw new Error("MCP HTTP server emitted invalid JSON-RPC");
  return value as JsonRpcMessage;
}
