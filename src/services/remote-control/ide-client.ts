import { readFile, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { resolve } from "node:path";

import type { IdeEditorContext } from "./ide-jsonrpc";
import type { RemoteControlDescriptor } from "./server";

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};

export type IdeBridgeCapabilities = {
  protocolVersion: "tnb.ide-jsonrpc/v1";
  capabilities: Record<string, boolean>;
  workspace: string;
};

export type IdeFileEvent = { file: string; type: "created" | "changed" | "deleted" };

export class IdeJsonRpcClient {
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private serverCapabilities: IdeBridgeCapabilities | undefined;
  private pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    cleanup(): void;
  }>();

  private constructor(
    private readonly socket: Socket,
    readonly descriptor: RemoteControlDescriptor,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.consume(chunk));
    socket.once("error", (error) => this.failAll(error));
    socket.once("close", () => this.failAll(new Error("IDE bridge connection closed")));
  }

  get server(): IdeBridgeCapabilities {
    if (!this.serverCapabilities) throw new Error("IDE bridge client is not initialized");
    return this.serverCapabilities;
  }

  static async connect(options: { descriptorPath: string; signal?: AbortSignal }): Promise<IdeJsonRpcClient> {
    const descriptor = await readPrivateDescriptor(options.descriptorPath);
    const socket = await connectSocket(descriptor.socketPath, options.signal);
    const client = new IdeJsonRpcClient(socket, descriptor);
    try {
      const server = await client.request<IdeBridgeCapabilities>(
        "initialize",
        { ownerToken: descriptor.ownerToken },
        options.signal,
      );
      if (server.protocolVersion !== "tnb.ide-jsonrpc/v1" || server.workspace !== descriptor.cwd) {
        throw new Error("IDE bridge initialization returned an incompatible server identity");
      }
      client.serverCapabilities = server;
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  request<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error("IDE bridge client is closed"));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const id = this.nextId++;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const abort = () => {
        this.pending.delete(id);
        rejectRequest(asError(signal?.reason ?? new DOMException("Aborted", "AbortError")));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, {
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
        cleanup,
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        pending.reject(error);
      });
    });
  }

  updateContext(context: Partial<IdeEditorContext> & { activeFile?: string | null; selection?: IdeEditorContext["selection"] | null }): Promise<{ accepted: true }> {
    return this.request("editor/updateContext", context as Record<string, unknown>);
  }

  getContext(): Promise<IdeEditorContext> {
    return this.request("editor/getContext");
  }

  didChangeFiles(events: IdeFileEvent[]): Promise<{ accepted: number; events: IdeFileEvent[] }> {
    return this.request("workspace/didChangeFiles", { events });
  }

  publishDiagnostics(file: string, diagnostics: IdeEditorContext["diagnostics"]): Promise<{ accepted: number }> {
    return this.request("textDocument/publishDiagnostics", { file, diagnostics });
  }

  openFile(file: string, line = 1, column = 1): Promise<{ file: string; line: number; column: number }> {
    return this.request("editor/openFile", { file, line, column });
  }

  applyWorkspaceEdit(changes: Record<string, unknown>, expectedHashes?: Record<string, string>): Promise<{ applied: true; files: string[] }> {
    return this.request("workspace/applyEdit", { changes, ...(expectedHashes ? { expectedHashes } : {}) });
  }

  diff(options: { path?: string; staged?: boolean } = {}): Promise<{ diff: string }> {
    return this.request("workspace/diff", options);
  }

  status(): Promise<{ cwd: string; context: IdeEditorContext }> {
    return this.request("workspace/status");
  }

  query(prompt: string, sessionId?: string): Promise<unknown> {
    return this.request("agent/query", { prompt, ...(sessionId ? { sessionId } : {}) });
  }

  createTerminal(command: string, options: { cols?: number; rows?: number } = {}): Promise<unknown> {
    return this.request("terminal/create", { command, ...options });
  }

  writeTerminal(pid: number, chars: string, submit?: boolean): Promise<unknown> {
    return this.request("terminal/write", { pid, chars, ...(submit === undefined ? {} : { submit }) });
  }

  resizeTerminal(pid: number, cols: number, rows: number): Promise<unknown> {
    return this.request("terminal/resize", { pid, cols, rows });
  }

  closeTerminal(pid: number): Promise<{ closed: true }> {
    return this.request("terminal/close", { pid });
  }

  async shutdown(): Promise<void> {
    try {
      await this.request("shutdown");
    } finally {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.failAll(new Error("IDE bridge client closed"));
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        this.failAll(new Error("IDE bridge returned invalid JSON"));
        this.socket.destroy();
        return;
      }
      if (response.jsonrpc !== "2.0" || !Number.isSafeInteger(response.id)) continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      pending.cleanup();
      if (response.error) pending.reject(new Error(`IDE bridge error ${response.error.code}: ${response.error.message}`));
      else pending.resolve(response.result);
    }
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function readPrivateDescriptor(path: string): Promise<RemoteControlDescriptor> {
  const absolutePath = resolve(path);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(`IDE bridge descriptor is not a file: ${absolutePath}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`IDE bridge descriptor must not be accessible by group or other users: ${absolutePath}`);
  const value: unknown = JSON.parse(await readFile(absolutePath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid IDE bridge descriptor: ${absolutePath}`);
  const descriptor = value as Partial<RemoteControlDescriptor>;
  if (
    descriptor.protocol !== "tnb.stream-json/v1" || !descriptor.protocols?.includes("tnb.ide-jsonrpc/v1") ||
    typeof descriptor.socketPath !== "string" || typeof descriptor.cwd !== "string" ||
    typeof descriptor.ownerToken !== "string" || !descriptor.ownerToken || !Number.isSafeInteger(descriptor.pid)
  ) throw new Error(`Invalid IDE bridge descriptor: ${absolutePath}`);
  return descriptor as RemoteControlDescriptor;
}

async function connectSocket(path: string, signal?: AbortSignal): Promise<Socket> {
  return new Promise<Socket>((resolveConnection, rejectConnection) => {
    const socket = createConnection(path);
    const abort = () => {
      socket.destroy();
      rejectConnection(asError(signal?.reason ?? new DOMException("Aborted", "AbortError")));
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      socket.off("error", rejectConnection);
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", rejectConnection);
    socket.once("connect", () => {
      cleanup();
      resolveConnection(socket);
    });
  });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
