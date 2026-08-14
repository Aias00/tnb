import type { McpLogLevel } from "./logging";

export type JsonRpcId = number | string;

export type JsonRpcMessage =
  | { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | {
      jsonrpc: "2.0";
      id: JsonRpcId;
      error: { code: number; message: string; data?: unknown };
    };

export interface McpTransport {
  readonly supportsModernProtocolProbe?: boolean;
  prepareLegacyFallback?(): Promise<void>;
  registerToolDefinitions?(tools: McpToolDefinition[]): McpToolDefinition[];
  start(
    receive: (message: JsonRpcMessage) => void,
    onError?: (error: Error) => void,
  ): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
}

export class McpSessionExpiredError extends Error {
  constructor() {
    super("MCP HTTP session expired");
    this.name = "McpSessionExpiredError";
  }
}

export class McpHttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`MCP HTTP request failed (${status}): ${body}`);
    this.name = "McpHttpError";
  }
}

export type McpProtocolMode = "legacy" | "auto" | typeof LATEST_MCP_PROTOCOL_VERSION;

export class McpRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpRequestError";
  }
}

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

export type McpToolResult = {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
};

export type McpResourceDefinition = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  size?: number;
};

export type McpResourceTemplate = {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

export type McpResourceContent = {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
};

export type McpPromptDefinition = {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

export type McpPromptResult = {
  description?: string;
  messages: Array<{
    role: "user" | "assistant";
    content: Record<string, unknown>;
  }>;
};

export type McpCompletionReference =
  | { type: "ref/prompt"; name: string }
  | { type: "ref/resource"; uri: string };

export type McpCompletionResult = {
  values: string[];
  total?: number;
  hasMore?: boolean;
};

export const LATEST_MCP_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_MCP_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

export const MCP_TIMEOUT_DEFAULTS = {
  connectionMs: 30_000,
  requestMs: 60_000,
  toolMs: 100_000_000,
} as const;

type PendingRequest = {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
};

type NotificationListener = (params: unknown) => void;

export type McpSubscriptionNotifications = {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
  taskIds?: string[];
};

export type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export type McpTask = {
  taskId: string;
  status: McpTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  inputRequests?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
};

export type McpSubscription = {
  readonly id: JsonRpcId;
  readonly honored: Readonly<McpSubscriptionNotifications>;
  readonly closed: Promise<"graceful" | "cancelled">;
  close(): Promise<void>;
};

export class McpClient {
  private readonly connectionTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly toolTimeoutMs: number;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private nextProgressToken = 1;
  private started = false;
  private connected = false;
  private capabilities: Record<string, unknown> = {};
  private readonly notificationListeners = new Map<string, Set<NotificationListener>>();
  private readonly resourceSubscriptions = new Set<string>();
  private subscription: McpSubscription | undefined;
  private subscriptionBase: McpSubscriptionNotifications | undefined;
  private recovery: Promise<void> | undefined;
  private closing = false;
  private protocolEra: "unknown" | "modern" | "legacy" = "unknown";
  private protocolVersion = LATEST_MCP_PROTOCOL_VERSION;
  private readonly sampling: ((params: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
  private readonly elicitation: ((params: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
  private readonly roots: (() => Array<{ uri: string; name?: string }> | Promise<Array<{ uri: string; name?: string }>>) | undefined;
  private readonly inbound = new Map<JsonRpcId, AbortController>();
  private readonly protocolMode: McpProtocolMode;

  constructor(
    private readonly transport: McpTransport,
    options?: {
      connectionTimeoutMs?: number;
      requestTimeoutMs?: number;
      toolTimeoutMs?: number;
      protocolMode?: McpProtocolMode;
      sampling?(params: unknown, signal: AbortSignal): Promise<unknown>;
      elicitation?(params: unknown, signal: AbortSignal): Promise<unknown>;
      roots?(): Array<{ uri: string; name?: string }> | Promise<Array<{ uri: string; name?: string }>>;
    },
  ) {
    this.connectionTimeoutMs = options?.connectionTimeoutMs ??
      positiveEnvironmentInteger("MCP_TIMEOUT") ?? MCP_TIMEOUT_DEFAULTS.connectionMs;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? MCP_TIMEOUT_DEFAULTS.requestMs;
    this.toolTimeoutMs = options?.toolTimeoutMs ??
      positiveEnvironmentInteger("MCP_TOOL_TIMEOUT") ?? MCP_TIMEOUT_DEFAULTS.toolMs;
    this.protocolMode = options?.protocolMode ?? "legacy";
    this.sampling = options?.sampling;
    this.elicitation = options?.elicitation;
    this.roots = options?.roots;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.started) {
      await this.transport.start(
        (message) => this.receive(message),
        (error) => {
          if (error instanceof McpSessionExpiredError && !this.closing) {
            void this.recoverSession().catch((recoveryError) => {
              this.failPending(normalizeError(recoveryError));
            });
            return;
          }
          this.failPending(error);
        },
      );
      this.started = true;
    }
    if (this.protocolMode !== "legacy") {
      if (!this.transport.supportsModernProtocolProbe) {
        throw new Error("This MCP transport does not support 2026-07-28 protocol discovery");
      }
      const modern = await this.tryModernDiscovery();
      if (modern) return;
      await this.transport.prepareLegacyFallback?.();
    }
    await this.initializeSession(false);
  }

  private async tryModernDiscovery(): Promise<boolean> {
    this.protocolEra = "modern";
    try {
      const result = asObject(
        await this.requestOnce(
          "server/discover",
          {},
          undefined,
          this.connectionTimeoutMs,
        ),
        "server/discover result",
      );
      this.applyDiscovery(result);
      this.connected = true;
      return true;
    } catch (error) {
      if (error instanceof McpRequestError && error.code === -32022) {
        const supported = supportedVersionsFromError(error.data);
        const selected = supported.find((version) => version === LATEST_MCP_PROTOCOL_VERSION);
        if (!selected) {
          throw new Error(
            `MCP server does not support ${LATEST_MCP_PROTOCOL_VERSION}; supported versions: ${supported.join(", ") || "unknown"}`,
          );
        }
        this.protocolVersion = selected;
        return await this.tryModernDiscovery();
      }
      if (this.protocolMode === LATEST_MCP_PROTOCOL_VERSION) {
        throw new Error(`MCP server did not accept pinned protocol ${LATEST_MCP_PROTOCOL_VERSION}`, {
          cause: error,
        });
      }
      if (error instanceof McpHttpError && error.status !== 400 && error.status !== 404) {
        throw error;
      }
      this.protocolEra = "legacy";
      this.protocolVersion = LEGACY_PROTOCOL_VERSION;
      return false;
    }
  }

  private applyDiscovery(result: Record<string, unknown>): void {
    assertCompleteResult(result, "server/discover");
    if (
      !Array.isArray(result.supportedVersions) ||
      result.supportedVersions.some((version) => typeof version !== "string")
    ) {
      throw new Error("MCP server/discover result has no supportedVersions array");
    }
    if (!(result.supportedVersions as string[]).includes(this.protocolVersion)) {
      throw new Error(`MCP server/discover does not support negotiated version ${this.protocolVersion}`);
    }
    this.capabilities = asObject(result.capabilities, "server capabilities");
  }

  private async initializeSession(restoreSubscriptions: boolean): Promise<void> {
    this.protocolEra = "legacy";
    this.protocolVersion = LEGACY_PROTOCOL_VERSION;
    const result = asObject(
      await this.request("initialize", {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {
          ...(this.sampling ? { sampling: { tools: {} } } : {}),
          ...(this.elicitation ? { elicitation: { form: {}, url: {} } } : {}),
          ...(this.roots ? { roots: { listChanged: true } } : {}),
        },
        clientInfo: { name: "tnb", version: "0.0.0" },
      }, undefined, this.connectionTimeoutMs, false),
      "initialize result",
    );
    if (
      typeof result.protocolVersion !== "string" ||
      !SUPPORTED_PROTOCOL_VERSIONS.has(result.protocolVersion)
    ) {
      throw new Error(`Unsupported MCP protocol version: ${String(result.protocolVersion)}`);
    }
    const capabilities = asObject(result.capabilities, "server capabilities");
    this.capabilities = capabilities;
    if (!("tools" in capabilities) && !("resources" in capabilities) && !("prompts" in capabilities)) {
      throw new Error("MCP server declares none of the tools, resources, or prompts capabilities");
    }
    await this.notify("notifications/initialized");
    this.connected = true;
    if (restoreSubscriptions && this.supportsResourceSubscriptions()) {
      for (const uri of this.resourceSubscriptions) {
        asObject(
          await this.request(
            "resources/subscribe",
            { uri },
            undefined,
            this.requestTimeoutMs,
            false,
          ),
          "resources/subscribe result",
        );
      }
    }
  }

  async listTools(): Promise<McpToolDefinition[]> {
    this.assertConnected();
    if (!this.supportsCapability("tools")) return [];
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const result = asObject(
        await this.request("tools/list", cursor ? { cursor } : {}),
        "tools/list result",
      );
      if (!Array.isArray(result.tools)) throw new Error("MCP tools/list result has no tools array");
      tools.push(...result.tools.map(parseToolDefinition));
      if (result.nextCursor !== undefined && typeof result.nextCursor !== "string") {
        throw new Error("MCP tools/list nextCursor must be a string");
      }
      cursor = result.nextCursor as string | undefined;
    } while (cursor);
    return this.transport.registerToolDefinitions?.(tools) ?? tools;
  }

  async listResources(): Promise<McpResourceDefinition[]> {
    this.assertConnected();
    if (!this.supportsCapability("resources")) return [];
    const resources: McpResourceDefinition[] = [];
    let cursor: string | undefined;
    do {
      const result = asObject(
        await this.request("resources/list", cursor ? { cursor } : {}),
        "resources/list result",
      );
      if (!Array.isArray(result.resources)) {
        throw new Error("MCP resources/list result has no resources array");
      }
      resources.push(...result.resources.map(parseResourceDefinition));
      if (result.nextCursor !== undefined && typeof result.nextCursor !== "string") {
        throw new Error("MCP resources/list nextCursor must be a string");
      }
      cursor = result.nextCursor as string | undefined;
    } while (cursor);
    return resources;
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpResourceContent[]> {
    this.assertConnected();
    if (!this.supportsCapability("resources")) throw new Error("MCP server does not support resources");
    const result = asObject(
      await this.request("resources/read", { uri }, signal),
      "resources/read result",
    );
    if (!Array.isArray(result.contents)) {
      throw new Error("MCP resources/read result has no contents array");
    }
    return result.contents.map(parseResourceContent);
  }

  async listResourceTemplates(): Promise<McpResourceTemplate[]> {
    this.assertConnected();
    if (!this.supportsCapability("resources")) return [];
    const templates: McpResourceTemplate[] = [];
    let cursor: string | undefined;
    do {
      const result = asObject(
        await this.request("resources/templates/list", cursor ? { cursor } : {}),
        "resources/templates/list result",
      );
      if (!Array.isArray(result.resourceTemplates)) {
        throw new Error("MCP resources/templates/list result has no resourceTemplates array");
      }
      templates.push(...result.resourceTemplates.map(parseResourceTemplate));
      if (result.nextCursor !== undefined && typeof result.nextCursor !== "string") {
        throw new Error("MCP resources/templates/list nextCursor must be a string");
      }
      cursor = result.nextCursor as string | undefined;
    } while (cursor);
    return templates;
  }

  supportsResourceSubscriptions(): boolean {
    const resources = this.capabilities.resources;
    return typeof resources === "object" && resources !== null &&
      (resources as { subscribe?: unknown }).subscribe === true;
  }

  async subscribeResource(uri: string, signal?: AbortSignal): Promise<void> {
    this.assertConnected();
    if (!this.supportsResourceSubscriptions()) {
      throw new Error("MCP server does not support resource subscriptions");
    }
    if (this.resourceSubscriptions.has(uri)) return;
    if (this.protocolEra === "modern") {
      signal?.throwIfAborted();
      this.resourceSubscriptions.add(uri);
      await this.refreshModernSubscription();
      return;
    }
    asObject(await this.request("resources/subscribe", { uri }, signal), "resources/subscribe result");
    this.resourceSubscriptions.add(uri);
  }

  async unsubscribeResource(uri: string, signal?: AbortSignal): Promise<void> {
    this.assertConnected();
    if (!this.resourceSubscriptions.has(uri)) return;
    if (this.protocolEra === "modern") {
      signal?.throwIfAborted();
      this.resourceSubscriptions.delete(uri);
      await this.refreshModernSubscription();
      return;
    }
    asObject(await this.request("resources/unsubscribe", { uri }, signal), "resources/unsubscribe result");
    this.resourceSubscriptions.delete(uri);
  }

  onResourceUpdated(listener: (uri: string) => void): () => void {
    return this.onNotification("notifications/resources/updated", (params) => {
      const value = asObject(params, "resources/updated params");
      if (typeof value.uri !== "string" || !value.uri) {
        throw new Error("MCP resources/updated URI is required");
      }
      listener(value.uri);
    });
  }

  async listPrompts(): Promise<McpPromptDefinition[]> {
    this.assertConnected();
    if (!this.supportsCapability("prompts")) return [];
    const prompts: McpPromptDefinition[] = [];
    let cursor: string | undefined;
    do {
      const result = asObject(
        await this.request("prompts/list", cursor ? { cursor } : {}),
        "prompts/list result",
      );
      if (!Array.isArray(result.prompts)) {
        throw new Error("MCP prompts/list result has no prompts array");
      }
      prompts.push(...result.prompts.map(parsePromptDefinition));
      if (result.nextCursor !== undefined && typeof result.nextCursor !== "string") {
        throw new Error("MCP prompts/list nextCursor must be a string");
      }
      cursor = result.nextCursor as string | undefined;
    } while (cursor);
    return prompts;
  }

  async getPrompt(
    name: string,
    args: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<McpPromptResult> {
    this.assertConnected();
    if (!this.supportsCapability("prompts")) throw new Error("MCP server does not support prompts");
    const result = asObject(
      await this.request("prompts/get", { name, arguments: args }, signal),
      "prompts/get result",
    );
    if (result.description !== undefined && typeof result.description !== "string") {
      throw new Error("MCP prompts/get description must be a string");
    }
    if (!Array.isArray(result.messages)) {
      throw new Error("MCP prompts/get result has no messages array");
    }
    return {
      ...(typeof result.description === "string" ? { description: result.description } : {}),
      messages: result.messages.map(parsePromptMessage),
    };
  }

  async completeArgument(
    ref: McpCompletionReference,
    argument: { name: string; value: string },
    contextArguments: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<McpCompletionResult> {
    this.assertConnected();
    if (!("completions" in this.capabilities)) {
      throw new Error("MCP server does not support argument completions");
    }
    validateCompletionReference(ref);
    if (!argument.name) throw new Error("MCP completion argument name is required");
    for (const [name, value] of Object.entries(contextArguments)) {
      if (typeof value !== "string") {
        throw new Error(`MCP completion context argument ${name} must be a string`);
      }
    }
    const result = asObject(
      await this.request("completion/complete", {
        ref,
        argument,
        ...(Object.keys(contextArguments).length
          ? { context: { arguments: contextArguments } }
          : {}),
      }, signal),
      "completion/complete result",
    );
    const completion = asObject(result.completion, "completion/complete completion");
    if (
      !Array.isArray(completion.values) ||
      completion.values.length > 100 ||
      completion.values.some((value) => typeof value !== "string")
    ) {
      throw new Error("MCP completion values must be an array of at most 100 strings");
    }
    if (completion.total !== undefined && !Number.isInteger(completion.total)) {
      throw new Error("MCP completion total must be an integer");
    }
    if (completion.hasMore !== undefined && typeof completion.hasMore !== "boolean") {
      throw new Error("MCP completion hasMore must be boolean");
    }
    return {
      values: completion.values as string[],
      ...(completion.total === undefined ? {} : { total: completion.total as number }),
      ...(completion.hasMore === undefined ? {} : { hasMore: completion.hasMore as boolean }),
    };
  }

  async callTool(name: string, input: unknown, signal?: AbortSignal): Promise<McpToolResult> {
    this.assertConnected();
    const params = {
      name,
      arguments: input,
      _meta: { progressToken: `tnb-${this.nextProgressToken++}` },
    };
    let result: Record<string, unknown>;
    try {
      result = asObject(
        await this.request("tools/call", params, signal, this.toolTimeoutMs),
        "tools/call result",
      );
    } catch (error) {
      if (this.protocolEra !== "modern" || !(error instanceof McpRequestError) || error.code !== -32020) {
        throw error;
      }
      await this.listTools();
      result = asObject(
        await this.request("tools/call", params, signal, this.toolTimeoutMs),
        "tools/call result",
      );
    }
    if (!Array.isArray(result.content)) {
      throw new Error("MCP tools/call result has no content array");
    }
    if (result.isError !== undefined && typeof result.isError !== "boolean") {
      throw new Error("MCP tools/call isError must be a boolean");
    }
    return {
      content: result.content,
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      ...(result.isError !== undefined ? { isError: result.isError as boolean } : {}),
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.inbound.values()) controller.abort(new Error("MCP client closed"));
    this.inbound.clear();
    await this.subscription?.close().catch(() => undefined);
    this.subscription = undefined;
    if (this.connected && this.protocolEra === "legacy" && this.resourceSubscriptions.size > 0) {
      await Promise.allSettled(
        [...this.resourceSubscriptions].map((uri) => this.unsubscribeResource(uri)),
      );
      this.resourceSubscriptions.clear();
    }
    this.connected = false;
    const error = new Error("MCP client closed");
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.reject(error);
      this.pending.delete(id);
    }
    await this.transport.close();
  }

  supportsCapability(name: "tools" | "resources" | "prompts" | "logging"): boolean {
    return name in this.capabilities;
  }

  supportsListChanged(name: "tools" | "resources" | "prompts"): boolean {
    const capability = this.capabilities[name];
    return typeof capability === "object" && capability !== null &&
      (capability as { listChanged?: unknown }).listChanged === true;
  }

  supportsLegacyLogging(): boolean {
    return this.protocolEra === "legacy" && this.supportsCapability("logging");
  }

  supportsTasks(): boolean {
    const extensions = this.capabilities.extensions;
    return typeof extensions === "object" && extensions !== null &&
      "io.modelcontextprotocol/tasks" in extensions;
  }

  async listen(notifications: McpSubscriptionNotifications): Promise<McpSubscription> {
    this.assertConnected();
    if (this.protocolEra !== "modern") {
      throw new Error("MCP subscriptions/listen requires protocol version 2026-07-28");
    }
    const id = this.nextId++;
    let settleClosed!: (value: "graceful" | "cancelled") => void;
    const closed = new Promise<"graceful" | "cancelled">((resolve) => settleClosed = resolve);
    let settleAck!: (value: McpSubscriptionNotifications) => void;
    let rejectAck!: (error: Error) => void;
    const acknowledged = new Promise<McpSubscriptionNotifications>((resolve, reject) => {
      settleAck = resolve;
      rejectAck = reject;
    });
    const ackTimeout = setTimeout(() => {
      rejectAck(new Error("MCP subscriptions/listen acknowledgement timed out"));
    }, this.requestTimeoutMs);
    const removeAck = this.onNotification("notifications/subscriptions/acknowledged", (params) => {
      const value = asObject(params, "subscriptions acknowledgement");
      if (subscriptionId(value) !== id) return;
      clearTimeout(ackTimeout);
      settleAck(parseSubscriptionNotifications(value.notifications));
    });
    let pending!: PendingRequest;
    const response = new Promise<unknown>((resolve, reject) => {
      pending = { method: "subscriptions/listen", resolve, reject };
      this.pending.set(id, pending);
    });
    const sendTask = this.transport.send({
      jsonrpc: "2.0",
      id,
      method: "subscriptions/listen",
      params: this.withModernMetadata({ notifications }),
    });
    void sendTask.catch((error) => {
      const current = this.pending.get(id);
      if (!current) return;
      this.pending.delete(id);
      current.reject(normalizeError(error));
    });
    void response.then(
      () => settleClosed("graceful"),
      (error) => rejectAck(normalizeError(error)),
    ).finally(removeAck);
    try {
      const honored = await acknowledged;
      let cancelled = false;
      return {
        id,
        honored,
        closed,
        close: async () => {
          if (cancelled) return;
          cancelled = true;
          clearTimeout(ackTimeout);
          removeAck();
          const current = this.pending.get(id);
          if (current) {
            this.pending.delete(id);
          }
          await this.notify("notifications/cancelled", {
            requestId: id,
            reason: "Subscription closed by client",
          }).catch(() => undefined);
          settleClosed("cancelled");
        },
      };
    } catch (error) {
      clearTimeout(ackTimeout);
      removeAck();
      this.pending.delete(id);
      await this.notify("notifications/cancelled", { requestId: id }).catch(() => undefined);
      throw error;
    }
  }

  async listenForChanges(notifications: McpSubscriptionNotifications): Promise<void> {
    if (this.protocolEra !== "modern") return;
    this.subscriptionBase = { ...notifications };
    await this.refreshModernSubscription();
  }

  async getTask(taskId: string, signal?: AbortSignal): Promise<McpTask> {
    this.assertTaskSupport();
    return parseTask(await this.request("tasks/get", { taskId }, signal));
  }

  async cancelTask(taskId: string, signal?: AbortSignal): Promise<void> {
    this.assertTaskSupport();
    assertCompleteResult(asObject(await this.request("tasks/cancel", { taskId }, signal), "tasks/cancel result"), "tasks/cancel");
  }

  async setLoggingLevel(level: McpLogLevel): Promise<void> {
    this.assertConnected();
    if (!this.supportsLegacyLogging()) {
      throw new Error("MCP server does not support legacy logging");
    }
    await this.request("logging/setLevel", { level });
  }

  onNotification(method: string, listener: NotificationListener): () => void {
    const listeners = this.notificationListeners.get(method) ?? new Set<NotificationListener>();
    listeners.add(listener);
    this.notificationListeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.notificationListeners.delete(method);
    };
  }

  async notifyRootsChanged(): Promise<void> {
    if (!this.connected || !this.roots || this.protocolEra === "modern") return;
    await this.notify("notifications/roots/list_changed");
  }

  private async request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs,
    recoverExpiredSession = true,
  ): Promise<unknown> {
    try {
      let requestParams = params;
      while (true) {
        const result = await this.requestOnce(method, requestParams, signal, timeoutMs);
        if (this.protocolEra !== "modern") return result;
        const object = asObject(result, `${method} result`);
        const resultType = object.resultType ?? "complete";
        if (resultType === "complete") return object;
        if (resultType === "task") {
          if (!this.supportsTasks()) throw new Error(`MCP ${method} returned a task without negotiating task support`);
          return await this.awaitTask(parseTask(object), signal);
        }
        if (resultType !== "input_required") {
          throw new Error(`MCP ${method} returned unsupported resultType: ${String(resultType)}`);
        }
        if (method !== "tools/call" && method !== "resources/read" && method !== "prompts/get") {
          throw new Error(`MCP ${method} cannot return input_required`);
        }
        requestParams = await this.buildMrtrRetryParams(params, object, signal);
      }
    } catch (error) {
      if (
        recoverExpiredSession &&
        error instanceof McpSessionExpiredError &&
        method !== "initialize" &&
        !this.closing
      ) {
        await this.recoverSession();
        return await this.requestOnce(method, params, signal, timeoutMs);
      }
      throw error;
    }
  }

  private async requestOnce(
    method: string,
    params: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      let pending: PendingRequest;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        pending.removeAbortListener?.();
        void this.notify("notifications/cancelled", {
          requestId: id,
          reason: "Request timed out",
        }).catch(() => undefined);
        reject(new Error(`MCP request ${method} timed out`));
      }, timeoutMs);
      pending = { method, resolve, reject, timer };
      if (signal) {
        const abort = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          void this.notify("notifications/cancelled", {
            requestId: id,
            reason: "Client request aborted",
          }).catch(() => undefined);
          reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", abort, { once: true });
        pending.removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      this.pending.set(id, pending);
    });
    try {
      await this.transport.send({
        jsonrpc: "2.0",
        id,
        method,
        params: this.protocolEra === "modern" ? this.withModernMetadata(params) : params,
      });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.removeAbortListener?.();
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return result;
  }

  private withModernMetadata(params: unknown): Record<string, unknown> {
    const value = params === undefined ? {} : asObject(params, "MCP request params");
    const existingMeta = value._meta === undefined ? {} : asObject(value._meta, "MCP request _meta");
    return {
      ...value,
      _meta: {
        ...existingMeta,
        "io.modelcontextprotocol/protocolVersion": this.protocolVersion,
        "io.modelcontextprotocol/clientInfo": { name: "tnb", version: "0.0.0" },
        "io.modelcontextprotocol/clientCapabilities": this.clientCapabilities(),
      },
    };
  }

  private clientCapabilities(): Record<string, unknown> {
    return {
      ...(this.sampling ? { sampling: { tools: {} } } : {}),
      ...(this.elicitation ? { elicitation: { form: {}, url: {} } } : {}),
      ...(this.roots && this.protocolEra !== "modern" ? { roots: { listChanged: true } } : {}),
      ...(this.protocolEra === "modern"
        ? { extensions: { "io.modelcontextprotocol/tasks": {} } }
        : {}),
    };
  }

  private async awaitTask(initial: McpTask, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const answered = new Set<string>();
    let task = initial;
    try {
      while (true) {
        signal?.throwIfAborted();
        if (task.status === "completed") {
          if (!task.result) throw new Error(`MCP task ${task.taskId} completed without a result`);
          return task.result;
        }
        if (task.status === "failed") {
          const error = task.error ?? {};
          throw new McpRequestError(
            typeof error.code === "number" ? error.code : -32603,
            typeof error.message === "string" ? error.message : `MCP task ${task.taskId} failed`,
            error.data,
          );
        }
        if (task.status === "cancelled") throw new Error(`MCP task ${task.taskId} was cancelled`);
        if (task.status === "input_required") {
          const responses = await this.fulfillInputRequests(task.inputRequests ?? {}, answered, signal);
          if (Object.keys(responses).length > 0) {
            assertCompleteResult(asObject(
              await this.requestOnce("tasks/update", { taskId: task.taskId, inputResponses: responses }, signal, this.requestTimeoutMs),
              "tasks/update result",
            ), "tasks/update");
          }
        }
        await abortableDelay(normalizePollInterval(task.pollIntervalMs), signal);
        task = await this.getTask(task.taskId, signal);
      }
    } catch (error) {
      if (signal?.aborted) {
        await this.requestOnce("tasks/cancel", { taskId: task.taskId }, undefined, this.requestTimeoutMs)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private async fulfillInputRequests(
    inputRequests: Record<string, unknown>,
    answered: Set<string>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const inputResponses: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(inputRequests)) {
      if (answered.has(key)) continue;
      signal?.throwIfAborted();
      const request = asObject(value, `MCP input request ${key}`);
      if (typeof request.method !== "string") throw new Error(`MCP input request ${key} has no method`);
      const handler = request.method === "sampling/createMessage"
        ? this.sampling
        : request.method === "elicitation/create"
          ? this.elicitation
          : request.method === "roots/list" && this.roots
            ? async () => ({ roots: await this.roots!() })
            : undefined;
      if (!handler) throw new Error(`Unsupported MCP input request method: ${request.method}`);
      inputResponses[key] = await handler(request.params, signal ?? new AbortController().signal);
      answered.add(key);
    }
    return inputResponses;
  }

  private async refreshModernSubscription(): Promise<void> {
    if (!this.subscriptionBase || this.protocolEra !== "modern") return;
    const next = {
      ...this.subscriptionBase,
      ...(this.resourceSubscriptions.size
        ? { resourceSubscriptions: [...this.resourceSubscriptions] }
        : {}),
    };
    await this.subscription?.close();
    this.subscription = hasSubscriptionNotifications(next)
      ? await this.listen(next)
      : undefined;
  }

  private assertTaskSupport(): void {
    this.assertConnected();
    if (this.protocolEra !== "modern" || !this.supportsTasks()) {
      throw new Error("MCP server does not support the tasks extension");
    }
  }

  private async buildMrtrRetryParams(
    originalParams: unknown,
    result: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (result.inputRequests === undefined && result.requestState === undefined) {
      throw new Error("MCP input_required result must include inputRequests or requestState");
    }
    if (result.requestState !== undefined && typeof result.requestState !== "string") {
      throw new Error("MCP input_required requestState must be a string");
    }
    const inputResponses = await this.fulfillInputRequests(
      result.inputRequests === undefined
        ? {}
        : asObject(result.inputRequests, "MCP inputRequests"),
      new Set(),
      signal,
    );
    return {
      ...asObject(originalParams, "MCP request params"),
      ...(Object.keys(inputResponses).length ? { inputResponses } : {}),
      ...(typeof result.requestState === "string" ? { requestState: result.requestState } : {}),
    };
  }

  private async recoverSession(): Promise<void> {
    if (this.recovery) return await this.recovery;
    this.connected = false;
    const recovery = this.initializeSession(true);
    this.recovery = recovery;
    try {
      await recovery;
    } finally {
      if (this.recovery === recovery) this.recovery = undefined;
    }
  }

  private notify(method: string, params?: unknown): Promise<void> {
    return this.transport.send({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private receive(message: JsonRpcMessage): void {
    if ("method" in message && !("id" in message)) {
      if (message.method === "notifications/cancelled") {
        const params = typeof message.params === "object" && message.params !== null
          ? message.params as { requestId?: unknown; reason?: unknown }
          : undefined;
        if (typeof params?.requestId === "number" || typeof params?.requestId === "string") {
          this.inbound.get(params.requestId)?.abort(
            new Error(typeof params.reason === "string" ? params.reason : "MCP server cancelled request"),
          );
        }
      }
      for (const listener of this.notificationListeners.get(message.method) ?? []) {
        listener(message.params);
      }
      return;
    }
    if ("method" in message && "id" in message) {
      void this.handleServerRequest(message);
      return;
    }
    if (!("id" in message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    if ("error" in message) {
      pending.reject(new McpRequestError(
        message.error.code,
        `MCP error ${message.error.code}: ${message.error.message}`,
        message.error.data,
      ));
    } else {
      pending.resolve(message.result);
    }
  }

  private async handleServerRequest(
    message: Extract<JsonRpcMessage, { method: string; id: JsonRpcId }>,
  ): Promise<void> {
    const handler = message.method === "sampling/createMessage"
      ? this.sampling
      : message.method === "elicitation/create"
        ? this.elicitation
        : message.method === "roots/list" && this.roots
          ? async () => ({ roots: await this.roots!() })
        : undefined;
    if (!handler) {
      await this.sendServerError(message.id, -32601, `Unsupported MCP client method: ${message.method}`);
      return;
    }
    if (this.inbound.has(message.id)) {
      await this.sendServerError(message.id, -32600, "Duplicate MCP request id");
      return;
    }
    const controller = new AbortController();
    this.inbound.set(message.id, controller);
    try {
      const result = await handler(message.params, controller.signal);
      if (!controller.signal.aborted) {
        await this.transport.send({ jsonrpc: "2.0", id: message.id, result });
      }
    } catch (error) {
      const requestError = error instanceof McpRequestError
        ? error
        : controller.signal.aborted
          ? new McpRequestError(-32800, "Request cancelled")
          : new McpRequestError(-32603, "MCP client request failed");
      await this.sendServerError(
        message.id,
        requestError.code,
        requestError.message,
        requestError.data,
      );
    } finally {
      this.inbound.delete(message.id);
    }
  }

  private sendServerError(
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    return this.transport.send({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error("MCP client is not connected");
  }

  private failPending(error: Error): void {
    this.connected = false;
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function assertCompleteResult(result: Record<string, unknown>, method: string): void {
  const resultType = result.resultType ?? "complete";
  if (resultType !== "complete") {
    throw new Error(`MCP ${method} returned unsupported resultType: ${String(resultType)}`);
  }
}

function parseTask(value: unknown): McpTask {
  const task = asObject(value, "task");
  if (typeof task.taskId !== "string" || !task.taskId) throw new Error("MCP taskId is required");
  if (!["working", "input_required", "completed", "failed", "cancelled"].includes(String(task.status))) {
    throw new Error(`Invalid MCP task status: ${String(task.status)}`);
  }
  if (typeof task.createdAt !== "string" || typeof task.lastUpdatedAt !== "string") {
    throw new Error("MCP task timestamps are required");
  }
  if (task.ttlMs !== null && (!Number.isSafeInteger(task.ttlMs) || Number(task.ttlMs) < 0)) {
    throw new Error("MCP task ttlMs must be a non-negative integer or null");
  }
  if (task.pollIntervalMs !== undefined && (!Number.isSafeInteger(task.pollIntervalMs) || Number(task.pollIntervalMs) < 0)) {
    throw new Error("MCP task pollIntervalMs must be a non-negative integer");
  }
  const status = task.status as McpTaskStatus;
  const parsed: McpTask = {
    taskId: task.taskId,
    status,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs as number | null,
    ...(typeof task.statusMessage === "string" ? { statusMessage: task.statusMessage } : {}),
    ...(typeof task.pollIntervalMs === "number" ? { pollIntervalMs: task.pollIntervalMs } : {}),
  };
  if (status === "input_required") parsed.inputRequests = asObject(task.inputRequests, "task inputRequests");
  if (status === "completed") parsed.result = asObject(task.result, "task result");
  if (status === "failed") parsed.error = asObject(task.error, "task error");
  return parsed;
}

function subscriptionId(params: Record<string, unknown>): JsonRpcId | undefined {
  const meta = params._meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  const id = (meta as Record<string, unknown>)["io.modelcontextprotocol/subscriptionId"];
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

function parseSubscriptionNotifications(value: unknown): McpSubscriptionNotifications {
  const notifications = asObject(value, "subscription notifications");
  const result: McpSubscriptionNotifications = {};
  for (const key of ["toolsListChanged", "promptsListChanged", "resourcesListChanged"] as const) {
    if (notifications[key] !== undefined && typeof notifications[key] !== "boolean") {
      throw new Error(`MCP subscription ${key} must be boolean`);
    }
    if (notifications[key] === true) result[key] = true;
  }
  for (const key of ["resourceSubscriptions", "taskIds"] as const) {
    const entries = notifications[key];
    if (entries !== undefined && (!Array.isArray(entries) || entries.some((item) => typeof item !== "string"))) {
      throw new Error(`MCP subscription ${key} must be a string array`);
    }
    if (Array.isArray(entries)) result[key] = entries as string[];
  }
  return result;
}

function normalizePollInterval(value: number | undefined): number {
  return value === undefined ? 1_000 : Math.max(0, value);
}

function hasSubscriptionNotifications(value: McpSubscriptionNotifications): boolean {
  return value.toolsListChanged === true || value.promptsListChanged === true ||
    value.resourcesListChanged === true || Boolean(value.resourceSubscriptions?.length) ||
    Boolean(value.taskIds?.length);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new DOMException("Aborted", "AbortError"));
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function supportedVersionsFromError(data: unknown): string[] {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return [];
  const supported = (data as { supported?: unknown }).supported;
  return Array.isArray(supported)
    ? supported.filter((version): version is string => typeof version === "string")
    : [];
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function positiveEnvironmentInteger(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseToolDefinition(value: unknown): McpToolDefinition {
  const tool = asObject(value, "tool definition");
  if (typeof tool.name !== "string" || !tool.name) throw new Error("MCP tool name is required");
  const inputSchema = asObject(tool.inputSchema, `input schema for ${tool.name}`);
  if (tool.description !== undefined && typeof tool.description !== "string") {
    throw new Error(`MCP tool description for ${tool.name} must be a string`);
  }
  if (tool.annotations !== undefined) asObject(tool.annotations, `annotations for ${tool.name}`);
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description as string }),
    inputSchema,
    ...(tool.annotations === undefined
      ? {}
      : { annotations: tool.annotations as Record<string, unknown> }),
  };
}

function parseResourceDefinition(value: unknown): McpResourceDefinition {
  const resource = asObject(value, "resource definition");
  if (typeof resource.uri !== "string" || !resource.uri) throw new Error("MCP resource URI is required");
  for (const key of ["name", "description", "mimeType"] as const) {
    if (resource[key] !== undefined && typeof resource[key] !== "string") {
      throw new Error(`MCP resource ${key} must be a string`);
    }
  }
  if (resource.size !== undefined && (typeof resource.size !== "number" || resource.size < 0)) {
    throw new Error("MCP resource size must be a non-negative number");
  }
  return {
    uri: resource.uri,
    ...(typeof resource.name === "string" ? { name: resource.name } : {}),
    ...(typeof resource.description === "string" ? { description: resource.description } : {}),
    ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
    ...(typeof resource.size === "number" ? { size: resource.size } : {}),
  };
}

function parseResourceContent(value: unknown): McpResourceContent {
  const content = asObject(value, "resource content");
  if (typeof content.uri !== "string" || !content.uri) throw new Error("MCP resource content URI is required");
  if (content.mimeType !== undefined && typeof content.mimeType !== "string") {
    throw new Error("MCP resource content mimeType must be a string");
  }
  const hasText = typeof content.text === "string";
  const hasBlob = typeof content.blob === "string";
  if (hasText === hasBlob) throw new Error("MCP resource content must contain exactly one of text or blob");
  return {
    uri: content.uri,
    ...(typeof content.mimeType === "string" ? { mimeType: content.mimeType } : {}),
    ...(hasText ? { text: content.text as string } : { blob: content.blob as string }),
  };
}

function parseResourceTemplate(value: unknown): McpResourceTemplate {
  const template = asObject(value, "resource template");
  if (typeof template.uriTemplate !== "string" || !template.uriTemplate) {
    throw new Error("MCP resource template URI is required");
  }
  if (typeof template.name !== "string" || !template.name) {
    throw new Error("MCP resource template name is required");
  }
  for (const key of ["title", "description", "mimeType"] as const) {
    if (template[key] !== undefined && typeof template[key] !== "string") {
      throw new Error(`MCP resource template ${key} must be a string`);
    }
  }
  return {
    uriTemplate: template.uriTemplate,
    name: template.name,
    ...(typeof template.title === "string" ? { title: template.title } : {}),
    ...(typeof template.description === "string" ? { description: template.description } : {}),
    ...(typeof template.mimeType === "string" ? { mimeType: template.mimeType } : {}),
  };
}

function parsePromptDefinition(value: unknown): McpPromptDefinition {
  const prompt = asObject(value, "prompt definition");
  if (typeof prompt.name !== "string" || !prompt.name) throw new Error("MCP prompt name is required");
  if (prompt.description !== undefined && typeof prompt.description !== "string") {
    throw new Error("MCP prompt description must be a string");
  }
  if (prompt.arguments !== undefined && !Array.isArray(prompt.arguments)) {
    throw new Error("MCP prompt arguments must be an array");
  }
  const args = (prompt.arguments as unknown[] | undefined)?.map((value) => {
    const argument = asObject(value, "prompt argument");
    if (typeof argument.name !== "string" || !argument.name) throw new Error("MCP prompt argument name is required");
    if (argument.description !== undefined && typeof argument.description !== "string") {
      throw new Error("MCP prompt argument description must be a string");
    }
    if (argument.required !== undefined && typeof argument.required !== "boolean") {
      throw new Error("MCP prompt argument required must be boolean");
    }
    return {
      name: argument.name,
      ...(typeof argument.description === "string" ? { description: argument.description } : {}),
      ...(typeof argument.required === "boolean" ? { required: argument.required } : {}),
    };
  });
  return {
    name: prompt.name,
    ...(typeof prompt.description === "string" ? { description: prompt.description } : {}),
    ...(args ? { arguments: args } : {}),
  };
}

function parsePromptMessage(value: unknown): McpPromptResult["messages"][number] {
  const message = asObject(value, "prompt message");
  if (message.role !== "user" && message.role !== "assistant") {
    throw new Error("MCP prompt message role must be user or assistant");
  }
  return { role: message.role, content: asObject(message.content, "prompt message content") };
}

function validateCompletionReference(ref: McpCompletionReference): void {
  if (ref.type === "ref/prompt") {
    if (!ref.name) throw new Error("MCP completion prompt name is required");
    return;
  }
  if (!ref.uri) throw new Error("MCP completion resource template URI is required");
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid MCP ${label}`);
  }
  return value as Record<string, unknown>;
}
