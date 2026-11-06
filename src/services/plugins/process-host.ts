import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import workerSource from "./process-worker.js.txt" with { type: "text" };
import supervisorTemplate from "./process-supervisor.js.txt" with { type: "text" };
import { PROCESS_PLUGIN_PROTOCOL, type ProcessRequest, type ProcessResponse, type ProcessStateWrite } from "../../plugin-sdk/process";
import type { ExtensionContext, ExtensionDeclaration, ExtensionRegistration, PluginApplication, PluginChannel, ChannelPort } from "../../agent/extensions";
import type { AdapterPluginIdentity } from "../../agent/domain";
import { serviceSignature, type ServiceRef } from "../../agent/service-ref";
import { buildInfo } from "../update/build-info";

const MAX_FRAME = 256 * 1024, MAX_PENDING = 32;
const compiled = buildInfo().mode === "compiled";
const supervisorSource = supervisorTemplate.replace("__TNB_WORKER_SOURCE__", () => JSON.stringify(workerSource)).replace("__TNB_COMPILED__", () => String(compiled));
const sessions = new Set<ProcessSession>();
/** Reject lossy encodings (functions, handles, undefined object fields), not just circular JSON. */
function json(value: unknown): string {
  let nodes = 0;
  const visit = (item: unknown, depth = 0): void => {
    if (++nodes > 20000 || depth > 32) throw new Error("Process JSON complexity limit exceeded");
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return;
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    if (item && typeof item === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(item))) { for (const child of Object.values(item)) visit(child, depth + 1); return; }
    throw new Error("Process boundary requires JSON data; adapt handles and streams on the host");
  };
  visit(value); const result = JSON.stringify(value);
  if (Buffer.byteLength(result) > MAX_FRAME - 1024) throw new Error("Process frame exceeds limit");
  return result;
}
async function requestData(request: Request): Promise<ProcessRequest> {
  // A bounded reader avoids allocating an unbounded request before checking the frame budget.
  const reader = request.body?.getReader(); let body: string | null = null;
  if (reader) { const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
      if (size > 128 * 1024) throw new Error("Process HTTP body exceeds limit"); chunks.push(next.value); }
      body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  const value = { url: request.url, method: request.method, headers: [...request.headers], body }; json(value); return value;
}
function responseData(value: ProcessResponse): Response {
  json(value);
  if (!value || !Number.isInteger(value.status) || value.status < 200 || value.status > 599 || value.body != null && typeof value.body !== "string"
    || value.headers !== undefined && (!Array.isArray(value.headers) || value.headers.some(row => !Array.isArray(row) || row.length !== 2 || row.some(item => typeof item !== "string")))) throw new Error("Invalid process HTTP response");
  return new Response(value.body ?? null, { status: value.status, headers: value.headers });
}
function channelEvents(value: unknown): Array<{ externalId: string; actor: string; thread: string; text: string }> {
  if (!Array.isArray(value) || value.length > 1000 || value.some(row => !row || ["externalId", "actor", "thread", "text"].some(key => typeof row[key] !== "string" || !row[key] || row[key].length > (key === "text" ? 65536 : 4096)))) throw new Error("Invalid process channel events");
  return value;
}

class ProcessSession {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private readonly controller = new AbortController();
  private sequence = 0; private buffered = Buffer.alloc(0); private received = 0; private callbacks = 0;
  private stderrBytes = 0; private windowStarted = performance.now();
  private home = ""; private failure?: Error; private closing?: Promise<void>;
  private methods: string[] = [];
  private readonly abort = () => { this.fail(new Error("Plugin process scope cancelled; dispatched outcomes may be unknown")); };
  constructor(private readonly entry: string, private readonly context: ExtensionContext, private readonly declaration: ExtensionDeclaration) {}
  async start(configuration: unknown): Promise<string[]> {
    this.context.signal.throwIfAborted();
    if (sessions.size >= 32) throw new Error("Plugin process host capacity exceeded");
    sessions.add(this);
    try {
      this.home = await mkdtemp(join(tmpdir(), "tnb-plugin-process-"));
      const env: Record<string, string> = { HOME: this.home, USERPROFILE: this.home, TMPDIR: this.home, TMP: this.home, TEMP: this.home,
        XDG_CONFIG_HOME: this.home, XDG_DATA_HOME: this.home, XDG_CACHE_HOME: this.home, APPDATA: this.home, LOCALAPPDATA: this.home,
        PATH: process.platform === "win32" ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32` : "/usr/bin:/bin" };
      if (process.platform === "win32") env.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const args = compiled ? ["--internal-plugin-process", pathToFileURL(this.entry).href]
        : ["-e", supervisorSource, pathToFileURL(this.entry).href];
      const child = this.child = spawn(process.execPath, args, { cwd: dirname(this.entry), env, stdio: "pipe", detached: process.platform !== "win32", windowsHide: true });
      child.stdout.on("data", chunk => this.receive(chunk));
      // Drain but do not persist arbitrary plugin stderr or credentials.
      child.stderr.on("data", chunk => { this.resetWindow(); this.stderrBytes += chunk.length; if (this.stderrBytes > 1024 * 1024) this.fail(new Error("Plugin process stderr limit exceeded")); });
      child.on("error", () => this.fail(new Error("Plugin process failed to start")));
      child.on("exit", () => this.fail(new Error("Plugin process exited; dispatched outcomes may be unknown")));
      child.stdin.on("error", () => this.fail(new Error("Plugin process input closed")));
      this.context.signal.addEventListener("abort", this.abort, { once: true });
      if (this.context.signal.aborted) this.abort();
      const result = await this.call("initialize", { protocol: PROCESS_PLUGIN_PROTOCOL, context: { identity: this.context.identity,
        contribution: { kind: this.declaration.kind, id: this.declaration.id, version: this.declaration.version }, configuration: configuration ?? null } });
      const allowed = this.declaration.kind === "channel" ? ["poll", "send", "find", "receive", "observe", "close"] : ["handle", "close"];
      if (result?.protocol !== PROCESS_PLUGIN_PROTOCOL || !Array.isArray(result.methods) || new Set(result.methods).size !== result.methods.length
        || result.methods.some((name: unknown) => !allowed.includes(String(name))) || this.declaration.kind === "channel" && !result.methods.includes("send")
        || this.declaration.kind !== "channel" && !result.methods.includes("handle")) throw new Error("Plugin process handshake mismatch");
      return this.methods = result.methods;
    } catch (error) { await this.close(); throw error; }
  }
  call(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    signal?.throwIfAborted(); this.context.signal.throwIfAborted();
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error("Plugin process request capacity exceeded"));
    const id = `host:${++this.sequence}`;
    const line = json({ jsonrpc: "2.0", id, method, params }) + "\n";
    const abort = () => this.fail(new Error("Plugin process request cancelled; dispatched outcomes may be unknown"));
    signal?.addEventListener("abort", abort, { once: true });
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Plugin process request timed out; dispatched outcomes may be unknown")), method === "initialize" ? Math.max(5000, this.declaration.execution?.timeoutMs ?? 30000) : this.declaration.execution?.timeoutMs ?? 30000);
      this.pending.set(id, { resolve, reject, timer }); this.child!.stdin.write(line);
      if (signal?.aborted) abort();
    });
    return promise.finally(() => signal?.removeEventListener("abort", abort));
  }
  private receive(chunk: Buffer): void {
    if (this.failure) return;
    this.resetWindow();
    this.received += chunk.length; if (this.received > 64 * 1024 * 1024) { this.fail(new Error("Plugin process session output limit exceeded")); return; }
    this.buffered = Buffer.concat([this.buffered, chunk]);
    try {
      for (;;) {
        const end = this.buffered.indexOf(10); if (end < 0) break;
        if (end > MAX_FRAME) throw new Error("Plugin process frame exceeds limit");
        const message = JSON.parse(this.buffered.subarray(0, end).toString("utf8")); this.buffered = this.buffered.subarray(end + 1);
        if (!message || message.jsonrpc !== "2.0" || typeof message.id !== "string") throw new Error("Invalid plugin process message");
        if (message.method !== undefined) {
          if (!message.id.startsWith("worker:") || typeof message.method !== "string" || ++this.callbacks > 10000) throw new Error("Invalid plugin process callback");
          void this.callback(message).catch(() => this.fail(new Error("Plugin process callback failed")));
        } else {
          const job = this.pending.get(message.id); if (!job || !Object.hasOwn(message, "result") && !message.error) throw new Error("Unknown plugin process response");
          this.pending.delete(message.id); clearTimeout(job.timer);
          if (message.error) job.reject(new Error(`Plugin process operation failed: ${String(message.error.message ?? "error").slice(0, 2048)}`)); else job.resolve(message.result);
        }
      }
      if (this.buffered.length > MAX_FRAME) throw new Error("Plugin process frame exceeds limit");
    } catch { this.fail(new Error("Plugin process protocol violation")); }
  }
  private resetWindow(): void {
    if (performance.now() - this.windowStarted >= 60000) {
      this.windowStarted = performance.now(); this.received = 0; this.callbacks = 0; this.stderrBytes = 0;
    }
  }
  private activeCallbacks = 0;
  private async callback(message: { id: string; method: string; params: any }) {
    if (++this.activeCallbacks > MAX_PENDING) { this.fail(new Error("Plugin process callback capacity exceeded")); return; }
    try {
      this.controller.signal.throwIfAborted(); this.context.signal.throwIfAborted();
      const p = message.params; let result: unknown;
      const project = (row: any) => row ? { id: row.id, revision: row.revision, value: row.value } : null;
      if (message.method === "state.get") result = project(this.context.state.get(p.id));
      else if (message.method === "state.list") result = this.context.state.list(p.afterId ?? undefined, p.limit ?? undefined).map(project);
      else if (message.method === "state.command") {
        if (!Array.isArray(p.writes) || !p.writes.length || p.writes.length > 32 || new Set(p.writes.map((row: any) => row.id)).size !== p.writes.length) throw new Error("Invalid process state writes");
        result = this.context.state.command(p.id, { input: p.input, writes: p.writes }, tx => p.writes.map((row: ProcessStateWrite) => project(tx.save(row.id, row.value, row.previousRevision))));
      } else if (message.method === "service.call") {
        const ref = p.ref as ServiceRef<any>; serviceSignature(ref);
        if (!Object.hasOwn(ref.methods, p.method) || !Array.isArray(p.args) || p.args.length > 32) throw new Error("Invalid process service call");
        const service = this.context.service(ref) as Record<string, (...args: unknown[]) => unknown>;
        result = await service[p.method]!(...p.args);
      } else if (message.method === "contribution.request") {
        const request = p.request as ProcessRequest;
        result = await requestDataResponse(await this.context.request(p.ref, new Request(request.url, { method: request.method, headers: request.headers,
          ...(request.body !== null ? { body: request.body } : {}), signal: this.controller.signal })));
      } else throw new Error("Unknown process host method");
      this.controller.signal.throwIfAborted(); this.context.signal.throwIfAborted();
      this.child!.stdin.write(json({ jsonrpc: "2.0", id: message.id, result: result ?? null }) + "\n");
    } catch {
      // Host exceptions can contain credentials; expose a stable generic failure only.
      if (!this.failure) this.child!.stdin.write(json({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "Host capability call rejected" } }) + "\n");
    } finally { this.activeCallbacks--; }
  }
  private fail(error: Error): void {
    if (this.failure) return; this.failure = error; this.controller.abort();
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(error); } this.pending.clear();
    const child = this.child;
    if (child?.pid) {
      if (process.platform === "win32") {
        const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => child.kill("SIGKILL"));
      } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.context.signal.removeEventListener("abort", this.abort);
      if (!this.failure && !this.context.signal.aborted && this.methods.includes("close")) {
        const timer = setTimeout(() => this.fail(new Error("Plugin process cleanup timed out")), 500);
        try { await this.call("close", []); } catch { /* Kill below; never wait indefinitely for cooperative cleanup. */ }
        finally { clearTimeout(timer); }
      }
      const child = this.child;
      const exited = !child || child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once("exit", () => resolve()));
      try {
        this.fail(new Error("Plugin process closed")); await exited;
        if (this.home) await rm(this.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } finally { sessions.delete(this); }
    })();
  }
}
async function requestDataResponse(response: Response): Promise<ProcessResponse> {
  const value = await requestData(new Request("http://plugin/response", { method: "POST", body: response.body, duplex: "half" } as RequestInit));
  return { status: response.status, headers: [...response.headers], body: value.body };
}

/** Declarative proxy. No plugin entry or lifecycle function executes inside the owner. */
export function processRegistration(entry: string, declaration: ExtensionDeclaration, plugin: AdapterPluginIdentity): ExtensionRegistration {
  const open = async (context: ExtensionContext, configuration: unknown) => {
    const session = new ProcessSession(entry, context, declaration);
    context.onDispose(() => session.close()); const methods = await session.start(configuration);
    return { session, methods };
  };
  const definition: PluginApplication | PluginChannel = declaration.kind === "channel" ? { id: declaration.id, version: declaration.version,
    async connect(configuration, context) {
      const { session, methods } = await open(context, configuration);
      const port: ChannelPort = { send: async (message, signal) => {
        const result = await session.call("send", [message], signal); if (typeof result !== "string" || !result || result.length > 4096) throw new Error("Invalid process delivery receipt"); return result;
      }, close: () => session.close() };
      if (methods.includes("poll")) port.poll = (cursor, signal) => session.call("poll", [cursor ?? null], signal).then(value => {
        if (!value || typeof value.cursor !== "string" || value.cursor.length > 4096) throw new Error("Invalid process poll result");
        return { cursor: value.cursor, events: channelEvents(value.events) };
      });
      if (methods.includes("find")) port.find = async (message, signal) => { const result = await session.call("find", [message], signal); if (result !== null && (typeof result !== "string" || !result || result.length > 4096)) throw new Error("Invalid process find receipt"); return result ?? undefined; };
      if (methods.includes("receive")) port.receive = async (request, signal) => channelEvents(await session.call("receive", [await requestData(request)], signal));
      if (methods.includes("observe")) port.observe = (resource, signal) => session.call("observe", [resource], signal);
      return port;
    } } : { id: declaration.id, version: declaration.version, async start(context) {
      const { session } = await open(context, context.configuration);
      return { handle: async (request: Request) => responseData(await session.call("handle", [await requestData(request)], request.signal)) };
    } };
  return { declaration, plugin, definition };
}

/** Only compiled CLI internal dispatch calls this; stdin must initialize the versioned protocol. */
export async function runPluginProcessWorker(): Promise<void> {
  await new Function(`return (async () => {\n${supervisorSource}\n})()`)();
}
export async function runPluginProcessEntry(): Promise<void> {
  await new Function(`return (async () => {\n${workerSource}\n})()`)();
}
