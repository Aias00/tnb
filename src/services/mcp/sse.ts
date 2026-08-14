import type { JsonRpcMessage, McpTransport } from "./client";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type LegacySseMcpTransportOptions = {
  url: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  authorization?: () => Promise<string | undefined>;
  connectionTimeoutMs?: number;
};

export class LegacySseMcpTransport implements McpTransport {
  private readonly fetcher: FetchLike;
  private readonly abortController = new AbortController();
  private receive?: (message: JsonRpcMessage) => void;
  private onError: ((error: Error) => void) | undefined;
  private endpoint?: URL;
  private streamTask?: Promise<void>;
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  constructor(private readonly options: LegacySseMcpTransportOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async start(
    receive: (message: JsonRpcMessage) => void,
    onError?: (error: Error) => void,
  ): Promise<void> {
    if (this.streamTask) throw new Error("MCP SSE transport already started");
    this.receive = receive;
    this.onError = onError;
    let resolveEndpoint!: () => void;
    let rejectEndpoint!: (error: Error) => void;
    const endpointReady = new Promise<void>((resolve, reject) => {
      resolveEndpoint = resolve;
      rejectEndpoint = reject;
    });
    this.streamTask = this.consumeStream(resolveEndpoint, rejectEndpoint).catch((error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      rejectEndpoint(normalized);
      if (!this.abortController.signal.aborted) this.onError?.(normalized);
    });
    const timeoutMs = this.options.connectionTimeoutMs ?? 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        endpointReady,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`MCP SSE endpoint was not announced within ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      this.abortController.abort();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.endpoint) throw new Error("MCP SSE server has not announced its message endpoint");
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: await this.headers("application/json"),
      body: JSON.stringify(message),
      signal: this.abortController.signal,
    });
    if (!response.ok) {
      throw new Error(`MCP SSE send failed (${response.status}): ${await response.text()}`);
    }
  }

  async close(): Promise<void> {
    this.abortController.abort();
    await this.streamReader?.cancel().catch(() => undefined);
    await this.streamTask?.catch(() => undefined);
  }

  private async consumeStream(
    endpointReady: () => void,
    endpointFailed: (error: Error) => void,
  ): Promise<void> {
    const response = await this.fetcher(this.options.url, {
      method: "GET",
      headers: await this.headers(undefined, "text/event-stream"),
      signal: this.abortController.signal,
    });
    if (!response.ok) {
      throw new Error(`MCP SSE connection failed (${response.status}): ${await response.text()}`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== "text/event-stream") {
      throw new Error(`MCP SSE endpoint returned ${contentType ?? "no content type"}`);
    }
    if (!response.body) throw new Error("MCP SSE endpoint returned no response body");
    const reader = response.body.getReader();
    this.streamReader = reader;
    try {
      for await (const event of readSseEvents(reader)) {
        if (event.event === "endpoint") {
          const endpoint = new URL(event.data, this.options.url);
          if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
            throw new Error("MCP SSE message endpoint must use HTTP or HTTPS");
          }
          if (endpoint.origin !== new URL(this.options.url).origin) {
            throw new Error("MCP SSE message endpoint must use the configured server origin");
          }
          this.endpoint = endpoint;
          endpointReady();
        } else if (event.data && (event.event === "message" || !event.event)) {
          this.receive?.(parseMessage(event.data));
        }
      }
      if (!this.abortController.signal.aborted) {
        throw new Error("MCP SSE connection closed by the server");
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (!this.endpoint) endpointFailed(normalized);
      throw normalized;
    } finally {
      this.streamReader = undefined;
    }
  }

  private async headers(contentType?: string, accept?: string): Promise<Headers> {
    const headers = new Headers(this.options.headers);
    if (contentType) headers.set("content-type", contentType);
    if (accept) headers.set("accept", accept);
    const token = await this.options.authorization?.();
    if (token) headers.set("authorization", `Bearer ${token}`);
    return headers;
  }
}

export async function* readSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseFrame(frame);
        if (event) yield event;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    const event = parseSseFrame(buffer);
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

export type SseEvent = {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
};

function parseSseFrame(frame: string): SseEvent | undefined {
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trimStart();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    if (line.startsWith("id:")) {
      const value = line.slice(3).trimStart();
      if (!value.includes("\0")) id = value;
    }
    if (line.startsWith("retry:")) {
      const value = line.slice(6).trimStart();
      if (/^\d+$/.test(value)) retry = Number(value);
    }
  }
  if (!data.length && event === undefined && id === undefined && retry === undefined) return undefined;
  return {
    ...(event ? { event } : {}),
    data: data.join("\n"),
    ...(id === undefined ? {} : { id }),
    ...(retry === undefined ? {} : { retry }),
  };
}

function parseMessage(data: string): JsonRpcMessage {
  const value: unknown = JSON.parse(data);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("MCP SSE server emitted a non-object JSON-RPC message");
  }
  if ((value as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
    throw new Error("MCP SSE server emitted invalid JSON-RPC");
  }
  return value as JsonRpcMessage;
}
