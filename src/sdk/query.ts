import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { PermissionMode } from "../core/permissions";
import type { McpServerConfig } from "../services/mcp/config";
import type { TaskRecord, TaskUpdate } from "../services/tasks/manager";

export type SDKUserMessage = {
  type: "user";
  message: {
    role: "user";
    content: string | Array<{ type: "text"; text: string }>;
  };
  parent_tool_use_id?: string | null;
  session_id?: string;
};

export type SDKMessage = {
  type: string;
  session_id?: string;
  [key: string]: unknown;
};

export type CanUseToolResult =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };

export type CanUseTool = (
  toolName: string,
  input: unknown,
  options: { requestId: string; message: string; suggestedRule?: string },
) => Promise<CanUseToolResult> | CanUseToolResult;

export type QueryOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  provider?: string;
  model?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: string[];
  additionalDirectories?: string[];
  mcpConfig?: string[];
  strictMcpConfig?: boolean;
  sessionId?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  systemPromptFile?: string;
  appendSystemPrompt?: string;
  appendSystemPromptFile?: string;
  forkSession?: boolean;
  sessionName?: string;
  settings?: string;
  agents?: Record<string, unknown>;
  agent?: string;
  resume?: string;
  continue?: boolean;
  includePartialMessages?: boolean;
  includeHookEvents?: boolean;
  canUseTool?: CanUseTool;
  pathToTnbExecutable?: string;
  executableArgs?: string[];
  signal?: AbortSignal;
};

export type QueryInput = {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: QueryOptions;
};

export interface Query extends AsyncGenerator<SDKMessage, void, void> {
  interrupt(): Promise<void>;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  getContextUsage(): Promise<SDKContextUsage>;
  reloadPlugins(): Promise<SDKPluginReloadResult>;
  addMcpServer(name: string, server: McpServerConfig): Promise<unknown>;
  removeMcpServer(name: string): Promise<unknown>;
  setMcpServerEnabled(name: string, enabled: boolean): Promise<unknown>;
  reconnectMcpServer(name?: string): Promise<unknown>;
  createTask(input: { subject: string; description: string; activeForm?: string; metadata?: Record<string, unknown> }): Promise<TaskRecord>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  listTasks(): Promise<TaskRecord[]>;
  updateTask(taskId: string, update: TaskUpdate): Promise<TaskRecord | null>;
  stopTask(taskId: string): Promise<TaskRecord | null>;
  close(): void;
}

export type SDKContextUsage = {
  sessionId: string;
  estimatedTokens: number;
  contextWindow: number;
  remainingTokens: number;
  usage: Record<string, unknown>;
};

export type SDKPluginReloadResult = {
  plugins: Array<{ name: string; active: boolean; source: string }>;
  errors: Array<{ path: string; error: string }>;
};

export function query(input: QueryInput): Query {
  return new SubprocessQuery(input);
}

class SubprocessQuery implements Query {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #messages = new AsyncQueue<SDKMessage>();
  readonly #pendingControls = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  readonly #multiTurn: boolean;
  readonly #canUseTool: CanUseTool | undefined;
  readonly #abortHandler: (() => void) | undefined;
  #closed = false;
  #receivedResult = false;
  #stderr = "";

  constructor(input: QueryInput) {
    const options = input.options ?? {};
    if (options.permissionMode === "bypassPermissions" && options.env?.TNB_DISABLE_YOLO === "true") {
      throw new Error("bypassPermissions is disabled by TNB_DISABLE_YOLO");
    }
    this.#multiTurn = typeof input.prompt !== "string" || options.canUseTool !== undefined;
    this.#canUseTool = options.canUseTool;
    const cliPath = fileURLToPath(new URL("../entrypoints/cli.ts", import.meta.url));
    const executable = options.pathToTnbExecutable ?? process.execPath;
    const executableArgs = options.pathToTnbExecutable
      ? options.executableArgs ?? []
      : [cliPath];
    const args = [
      ...executableArgs,
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      ...(options.includePartialMessages === false ? [] : ["--include-partial-messages"]),
      ...(options.includeHookEvents ? ["--include-hook-events"] : []),
      ...(options.provider ? ["--provider", options.provider] : []),
      ...(options.model ? ["--model", options.model] : []),
      ...(options.permissionMode ? ["--permission-mode", options.permissionMode] : []),
      ...(options.allowedTools?.length ? ["--allowed-tools", options.allowedTools.join(",")] : []),
      ...(options.disallowedTools?.length ? ["--disallowed-tools", options.disallowedTools.join(",")] : []),
      ...(options.tools ? ["--tools", options.tools.join(",")] : []),
      ...(options.additionalDirectories?.flatMap((directory) => ["--add-dir", directory]) ?? []),
      ...(options.mcpConfig?.flatMap((config) => ["--mcp-config", config]) ?? []),
      ...(options.strictMcpConfig ? ["--strict-mcp-config"] : []),
      ...(options.maxTurns ? ["--max-turns", String(options.maxTurns)] : []),
      ...(options.maxBudgetUsd ? ["--max-budget-usd", String(options.maxBudgetUsd)] : []),
      ...(options.systemPrompt ? ["--system-prompt", options.systemPrompt] : []),
      ...(options.systemPromptFile ? ["--system-prompt-file", options.systemPromptFile] : []),
      ...(options.appendSystemPrompt ? ["--append-system-prompt", options.appendSystemPrompt] : []),
      ...(options.appendSystemPromptFile ? ["--append-system-prompt-file", options.appendSystemPromptFile] : []),
      ...(options.resume ? ["--resume", options.resume] : []),
      ...(options.continue ? ["--continue"] : []),
      ...(options.forkSession ? ["--fork-session"] : []),
      ...(options.sessionId ? ["--session-id", options.sessionId] : []),
      ...(options.sessionName ? ["--name", options.sessionName] : []),
      ...(options.settings ? ["--settings", options.settings] : []),
      ...(options.agents ? ["--agents", JSON.stringify(options.agents)] : []),
      ...(options.agent ? ["--agent", options.agent] : []),
    ];
    this.#child = spawn(executable, args, {
      cwd: options.cwd ?? process.cwd(),
      env: environment(options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => { this.#stderr += chunk; });
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("exit", (code, signal) => {
      if (!this.#closed && code !== 0 && !this.#receivedResult) {
        const detail = this.#stderr.trim() || `tnb exited with ${signal ? `signal ${signal}` : `code ${code}`}`;
        this.#fail(new Error(detail));
      } else {
        this.#finish();
      }
    });
    const lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => { void this.#handleLine(line); });
    lines.once("close", () => {
      if (this.#child.exitCode !== null) this.#finish();
    });
    if (options.signal) {
      this.#abortHandler = () => { void this.interrupt().catch(() => this.close()); };
      if (options.signal.aborted) this.#abortHandler();
      else options.signal.addEventListener("abort", this.#abortHandler, { once: true });
    }
    if (typeof input.prompt === "string") {
      this.#sendUser({
        type: "user",
        message: { role: "user", content: input.prompt },
        parent_tool_use_id: null,
      });
      if (!this.#multiTurn) this.#child.stdin.end();
    } else {
      void this.#pumpInput(input.prompt);
    }
  }

  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void, void> {
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  next(): Promise<IteratorResult<SDKMessage, void>> {
    return this.#messages.next();
  }

  async return(): Promise<IteratorResult<SDKMessage, void>> {
    this.close();
    return { value: undefined, done: true };
  }

  async throw(error?: unknown): Promise<IteratorResult<SDKMessage, void>> {
    this.close();
    throw error;
  }

  interrupt(): Promise<void> {
    this.#requireControl("interrupt");
    return this.#sendControl({ subtype: "interrupt" });
  }

  setModel(model: string): Promise<void> {
    this.#requireControl("setModel");
    if (!model.trim()) return Promise.reject(new Error("Model must be a non-empty string"));
    return this.#sendControl({ subtype: "set_model", model });
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    this.#requireControl("setPermissionMode");
    return this.#sendControl({ subtype: "set_permission_mode", mode });
  }

  getContextUsage(): Promise<SDKContextUsage> {
    this.#requireControl("getContextUsage");
    return this.#sendControl<SDKContextUsage>({ subtype: "context_usage" });
  }

  reloadPlugins(): Promise<SDKPluginReloadResult> {
    this.#requireControl("reloadPlugins");
    return this.#sendControl<SDKPluginReloadResult>({ subtype: "plugin_reload" });
  }

  addMcpServer(name: string, server: McpServerConfig): Promise<unknown> {
    this.#requireControl("addMcpServer");
    return this.#sendControl({ subtype: "mcp_add", name: requiredName(name, "MCP server"), server });
  }

  removeMcpServer(name: string): Promise<unknown> {
    this.#requireControl("removeMcpServer");
    return this.#sendControl({ subtype: "mcp_remove", name: requiredName(name, "MCP server") });
  }

  setMcpServerEnabled(name: string, enabled: boolean): Promise<unknown> {
    this.#requireControl("setMcpServerEnabled");
    return this.#sendControl({ subtype: enabled ? "mcp_enable" : "mcp_disable", name: requiredName(name, "MCP server") });
  }

  reconnectMcpServer(name?: string): Promise<unknown> {
    this.#requireControl("reconnectMcpServer");
    return this.#sendControl({ subtype: "mcp_reconnect", ...(name === undefined ? {} : { name: requiredName(name, "MCP server") }) });
  }

  createTask(input: { subject: string; description: string; activeForm?: string; metadata?: Record<string, unknown> }): Promise<TaskRecord> {
    this.#requireControl("createTask");
    return this.#sendControl<TaskRecord>({ subtype: "task_create", ...input });
  }

  getTask(taskId: string): Promise<TaskRecord | null> {
    this.#requireControl("getTask");
    return this.#sendControl<TaskRecord | null>({ subtype: "task_get", taskId: requiredName(taskId, "Task id") });
  }

  listTasks(): Promise<TaskRecord[]> {
    this.#requireControl("listTasks");
    return this.#sendControl<TaskRecord[]>({ subtype: "task_list" });
  }

  updateTask(taskId: string, update: TaskUpdate): Promise<TaskRecord | null> {
    this.#requireControl("updateTask");
    return this.#sendControl<TaskRecord | null>({ subtype: "task_update", taskId: requiredName(taskId, "Task id"), update });
  }

  stopTask(taskId: string): Promise<TaskRecord | null> {
    this.#requireControl("stopTask");
    return this.#sendControl<TaskRecord | null>({ subtype: "task_stop", taskId: requiredName(taskId, "Task id") });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    if (this.#child.exitCode === null) this.#child.kill("SIGTERM");
    this.#finish();
  }

  async #pumpInput(input: AsyncIterable<SDKUserMessage>): Promise<void> {
    try {
      for await (const message of input) this.#sendUser(message);
      this.#child.stdin.end();
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
      this.close();
    }
  }

  async #handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: SDKMessage;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("record must be an object");
      message = value as SDKMessage;
    } catch (error) {
      this.#fail(new Error(`Invalid tnb stream-json output: ${line}`, { cause: error }));
      return;
    }
    if (message.type === "control_response") {
      this.#handleControlResponse(message);
      return;
    }
    if (message.type === "control_request") {
      await this.#handleControlRequest(message);
      return;
    }
    if (message.type === "result") {
      this.#receivedResult = true;
      if (this.#multiTurn && typeof (message as { subtype?: unknown }).subtype === "string" && typeof this.#canUseTool === "function" && this.#child.stdin.writable) {
        this.#child.stdin.end();
      }
    }
    this.#messages.push(message);
  }

  #handleControlResponse(message: SDKMessage): void {
    const requestId = typeof message.request_id === "string" ? message.request_id : "";
    const pending = this.#pendingControls.get(requestId);
    if (!pending) return;
    this.#pendingControls.delete(requestId);
    const response = typeof message.response === "object" && message.response !== null
      ? message.response as Record<string, unknown>
      : {};
    if (response.subtype === "success") pending.resolve(response.payload);
    else pending.reject(new Error(typeof response.error === "string" ? response.error : "Control request failed"));
  }

  async #handleControlRequest(message: SDKMessage): Promise<void> {
    const requestId = typeof message.request_id === "string" ? message.request_id : "";
    const request = typeof message.request === "object" && message.request !== null
      ? message.request as Record<string, unknown>
      : {};
    if (!requestId || request.subtype !== "can_use_tool") return;
    let result: CanUseToolResult;
    try {
      result = this.#canUseTool
        ? await this.#canUseTool(
            typeof request.tool_name === "string" ? request.tool_name : "",
            request.input,
            {
              requestId,
              message: typeof request.message === "string" ? request.message : "Tool use requires approval",
              ...(typeof request.suggested_rule === "string" ? { suggestedRule: request.suggested_rule } : {}),
            },
          )
        : { behavior: "deny", message: "No canUseTool callback was provided" };
    } catch (error) {
      result = { behavior: "deny", message: error instanceof Error ? error.message : String(error) };
    }
    this.#write({
      type: "control_response",
      request_id: requestId,
      response: result,
    });
  }

  #sendUser(message: SDKUserMessage): void {
    this.#write(message);
  }

  #sendControl<T = void>(request: Record<string, unknown>): Promise<T> {
    const requestId = randomUUID();
    const response = new Promise<T>((resolve, reject) => {
      this.#pendingControls.set(requestId, { resolve: (value) => resolve(value as T), reject });
    });
    this.#write({ type: "control_request", request_id: requestId, request });
    return response;
  }

  #write(message: Record<string, unknown>): void {
    if (this.#closed || !this.#child.stdin.writable) throw new Error("tnb query input is closed");
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #requireControl(method: string): void {
    if (!this.#multiTurn) throw new Error(`${method} requires an AsyncIterable prompt or canUseTool callback`);
    if (this.#closed) throw new Error("tnb query is closed");
  }

  #fail(error: Error): void {
    this.#messages.fail(error);
    for (const pending of this.#pendingControls.values()) pending.reject(error);
    this.#pendingControls.clear();
  }

  #finish(): void {
    this.#messages.close();
    for (const pending of this.#pendingControls.values()) pending.reject(new Error("tnb exited before acknowledging control request"));
    this.#pendingControls.clear();
  }
}

function requiredName(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function environment(overrides: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

class AsyncQueue<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{ resolve(value: IteratorResult<T, void>): void; reject(error: Error): void }> = [];
  #closed = false;
  #error: Error | undefined;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }

  next(): Promise<IteratorResult<T, void>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#error) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: Error): void {
    if (this.#closed) return;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}
