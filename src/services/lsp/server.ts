import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TnbLspMessageDecoder, encodeTnbLspMessage } from "./jsonrpc";
import { TnbLspDiagnosticsRegistry } from "./diagnostics-registry";
import type {
  TnbJsonRpcFailure,
  TnbJsonRpcId,
  TnbJsonRpcMessage,
  TnbJsonRpcRequest,
  TnbJsonRpcSuccess,
  TnbLspDiagnostic,
  TnbLspOpenDocument,
  TnbLspResolvedSelector,
  TnbLspServerConfig,
  TnbLspServerState,
} from "./types";

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  removeAbortListener(): void;
};

const REQUEST_CANCELLED = -32800;

export class TnbLspServer {
  readonly name: string;
  readonly diagnostics: TnbLspDiagnosticsRegistry;
  #state: TnbLspServerState = "stopped";
  #child: ChildProcessWithoutNullStreams | undefined;
  #startPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #pending = new Map<TnbJsonRpcId, PendingRequest>();
  #decoder = new TnbLspMessageDecoder();
  #nextRequestId = 1;
  #initialized = false;
  #intentionalClose = false;
  #lastError: Error | undefined;
  #openDocuments = new Map<string, TnbLspOpenDocument>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly config: TnbLspServerConfig,
    diagnostics?: TnbLspDiagnosticsRegistry,
  ) {
    this.name = config.name;
    this.diagnostics = diagnostics ?? new TnbLspDiagnosticsRegistry();
  }

  get state(): TnbLspServerState {
    return this.#state;
  }

  get lastError(): Error | undefined {
    return this.#lastError;
  }

  async openDocument(filePath: string, selector: TnbLspResolvedSelector, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const text = await readFile(filePath, "utf8");
    await this.#ensureStarted(signal);
    const uri = pathToFileURL(filePath).href;
    const existing = this.#openDocuments.get(uri);
    if (!existing) {
      await this.#sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: selector.languageId,
          version: 1,
          text,
        },
      });
      this.#openDocuments.set(uri, { uri, languageId: selector.languageId, version: 1, text });
      return;
    }
    if (existing.text === text) return;
    const version = existing.version + 1;
    await this.#sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    await this.#sendNotification("textDocument/didSave", { textDocument: { uri } });
    this.#openDocuments.set(uri, { ...existing, version, text });
  }

  async request<TResult>(method: string, params: unknown, signal?: AbortSignal): Promise<TResult> {
    await this.#ensureStarted(signal);
    return this.#sendRequest<TResult>(method, params, signal);
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#doClose();
    try {
      await this.#closePromise;
    } finally {
      this.#closePromise = undefined;
    }
  }

  async #doClose(): Promise<void> {
    const child = this.#child;
    if (!child) {
      this.#resetRuntimeState("stopped");
      return;
    }
    this.#intentionalClose = true;
    this.#state = "stopping";
    if (this.#initialized) {
      try {
        await this.#sendRequest("shutdown", undefined, undefined, 1_000);
      } catch {}
      try {
        await this.#sendNotification("exit", undefined);
      } catch {}
    }
    child.stdin.end();
    if (!(await waitForExit(child, 500))) child.kill("SIGTERM");
    if (!(await waitForExit(child, 1_000))) child.kill("SIGKILL");
    await waitForExit(child, 1_000);
    this.#resetRuntimeState("stopped");
  }

  async #ensureStarted(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#state === "running" && this.#initialized && this.#child) return;
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#doStart(signal).finally(() => {
      this.#startPromise = undefined;
    });
    return this.#startPromise;
  }

  async #doStart(signal?: AbortSignal): Promise<void> {
    this.#intentionalClose = false;
    this.#state = "starting";
    this.#lastError = undefined;
    const child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd ?? this.workspaceRoot,
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer | string) => {
      try {
        for (const message of this.#decoder.push(chunk)) this.#handleMessage(message);
      } catch (error) {
        this.#markError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {
      if (this.config.traceStderr !== false) return;
    });
    child.on("error", (error) => this.#markError(error));
    child.on("exit", (code, signalName) => {
      const error = !this.#intentionalClose && (code !== 0 || signalName !== null)
        ? new Error(`LSP server ${this.name} exited unexpectedly (${code === null ? signalName : `code ${code}`})`)
        : undefined;
      if (error) this.#markError(error);
      this.#rejectAllPending(error ?? new Error(`LSP server ${this.name} closed`));
      if (!this.#intentionalClose) {
        this.#child = undefined;
        this.#initialized = false;
        this.#state = error ? "error" : "stopped";
      }
    });
    const removeAbort = bindAbort(signal, async () => {
      await this.close();
    });
    try {
      await waitForSpawn(child, signal);
      const rootUri = pathToFileURL(this.workspaceRoot).href;
      const initializeResult = await this.#sendRequest<{ capabilities?: unknown }>(
        "initialize",
        {
          processId: process.pid,
          rootUri,
          capabilities: {
            textDocument: {
              hover: {},
              definition: {},
              references: {},
              documentSymbol: {},
            },
          },
          workspaceFolders: [{ uri: rootUri, name: this.workspaceRoot.split(/[\\/]/).pop() ?? this.workspaceRoot }],
          initializationOptions: this.config.initializationOptions,
        },
        signal,
      );
      void initializeResult;
      await this.#sendNotification("initialized", {});
      this.#initialized = true;
      this.#state = "running";
    } catch (error) {
      this.#markError(error instanceof Error ? error : new Error(String(error)));
      await this.close().catch(() => undefined);
      throw error;
    } finally {
      removeAbort();
    }
  }

  async #sendRequest<TResult>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<TResult> {
    const child = this.#child;
    if (!child || !child.stdin.writable) throw new Error(`LSP server ${this.name} is not writable`);
    signal?.throwIfAborted();
    const id = this.#nextRequestId++;
    return new Promise<TResult>((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.removeAbortListener();
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      const removeAbortListener = bindAbort(signal, () => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        if (timer) clearTimeout(timer);
        void this.#sendNotification("$/cancelRequest", { id }).catch(() => undefined);
        reject(abortError());
      });
      this.#pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          removeAbortListener();
          resolve(value as TResult);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          removeAbortListener();
          reject(error);
        },
        removeAbortListener,
      });
      this.#writeMessage({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async #sendNotification(method: string, params: unknown): Promise<void> {
    await this.#writeMessage({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  async #writeMessage(message: TnbJsonRpcMessage): Promise<void> {
    const child = this.#child;
    if (!child || !child.stdin.writable) throw new Error(`LSP server ${this.name} is not writable`);
    const frame = encodeTnbLspMessage(message);
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(frame, (error) => error ? reject(error) : resolve());
    });
  }

  #handleMessage(message: TnbJsonRpcMessage): void {
    if ("method" in message && "id" in message) {
      void this.#handleServerRequest(message);
      return;
    }
    if ("method" in message) {
      this.#handleNotification(message.method, message.params);
      return;
    }
    if (message.id === null) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if ("error" in message) {
      pending.reject(new Error(formatJsonRpcError(message)));
      return;
    }
    pending.resolve(message.result);
  }

  async #handleServerRequest(message: TnbJsonRpcRequest): Promise<void> {
    const result = message.method === "workspace/configuration"
      ? []
      : message.method === "workspace/workspaceFolders"
        ? [{ uri: pathToFileURL(this.workspaceRoot).href, name: this.workspaceRoot.split(/[\\/]/).pop() ?? this.workspaceRoot }]
        : null;
    try {
      await this.#writeMessage({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.#markError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #handleNotification(method: string, params: unknown): void {
    if (method !== "textDocument/publishDiagnostics") return;
    const value = asObject(params, "publishDiagnostics params");
    const uri = requireString(value.uri, "publishDiagnostics uri");
    const filePath = fileURLToPath(uri);
    const diagnostics = Array.isArray(value.diagnostics)
      ? value.diagnostics.map(normalizeDiagnostic)
      : [];
    this.diagnostics.update({
      serverName: this.name,
      filePath,
      uri,
      ...(typeof value.version === "number" ? { version: value.version } : {}),
      diagnostics,
    });
  }

  #rejectAllPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  #markError(error: Error): void {
    this.#lastError = error;
    if (!this.#intentionalClose) this.#state = "error";
  }

  #resetRuntimeState(state: TnbLspServerState): void {
    this.#child = undefined;
    this.#initialized = false;
    this.#openDocuments.clear();
    this.#pending.clear();
    this.#decoder = new TnbLspMessageDecoder();
    this.#state = state;
  }
}

function normalizeDiagnostic(input: unknown): TnbLspDiagnostic {
  const value = asObject(input, "diagnostic");
  const range = asObject(value.range, "diagnostic range");
  const start = asObject(range.start, "diagnostic range start");
  const end = asObject(range.end, "diagnostic range end");
  const codeValue = value.code;
  return {
    message: requireString(value.message, "diagnostic message"),
    severity: normalizeSeverity(value.severity),
    ...(codeValue === undefined ? {} : { code: String(codeValue) }),
    ...(typeof value.source === "string" ? { source: value.source } : {}),
    startLine: requireNonNegativeInteger(start.line, "diagnostic start line"),
    startCharacter: requireNonNegativeInteger(start.character, "diagnostic start character"),
    endLine: requireNonNegativeInteger(end.line, "diagnostic end line"),
    endCharacter: requireNonNegativeInteger(end.character, "diagnostic end character"),
  };
}

function normalizeSeverity(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4) return value;
  return 3;
}

function asObject(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function requireString(input: unknown, label: string): string {
  if (typeof input !== "string" || !input) throw new Error(`${label} must be a non-empty string`);
  return input;
}

function requireNonNegativeInteger(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return input;
}

function formatJsonRpcError(message: TnbJsonRpcFailure): string {
  return `LSP request failed (${message.error.code}): ${message.error.message}`;
}

function bindAbort(signal: AbortSignal | undefined, handler: () => void | Promise<void>): () => void {
  if (!signal) return () => undefined;
  const listener = () => {
    void handler();
  };
  signal.addEventListener("abort", listener, { once: true });
  return () => signal.removeEventListener("abort", listener);
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

async function waitForSpawn(child: ChildProcessWithoutNullStreams, signal?: AbortSignal): Promise<void> {
  if (child.pid === undefined) throw new Error("LSP server process failed to spawn");
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}
