import { createWriteStream, realpathSync, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Terminal } from "@xterm/headless";
import { resolveShellInvocation } from "../../core/shell-permissions";
import type { SandboxRuntime } from "../sandbox/macos";
import { probeSandboxRuntime } from "../sandbox/probe";
import type { ToolProgressReporter } from "../../core/tool";

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;
export const DEFAULT_PTY_COLS = 160;
export const DEFAULT_PTY_ROWS = 50;
export const DEFAULT_PTY_WAIT_MS = 800;
export const DEFAULT_PTY_IDLE_MS = 120;
export const MAX_PTY_SESSIONS = 10;
export const PTY_SESSION_TTL_MS = 1_800_000;

const TASK_OUTPUT_CHARS = 160_000;
const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;

export type ShellTaskStatus = "running" | "completed" | "failed" | "killed";

export type ShellTaskSnapshot = {
  taskId: string;
  pid: number;
  command: string;
  status: ShellTaskStatus;
  exitCode?: number;
  output: string;
  outputPath: string;
};

export type PtySnapshot = {
  pid: number;
  command: string;
  alive: boolean;
  exitCode?: number;
  cols: number;
  rows: number;
  screen: string;
};

export type ShellRuntimeSnapshot =
  | ({ kind: "background" } & ShellTaskSnapshot)
  | ({ kind: "pty" } & PtySnapshot);

type BackgroundTask = {
  id: string;
  pid: number;
  command: string;
  process: ChildProcessWithoutNullStreams;
  status: ShellTaskStatus;
  exitCode?: number;
  output: string;
  outputBytes: number;
  outputPath: string;
  writer: WriteStream;
  result: Promise<void>;
  lineBuffer: string;
  onStdoutLine?: (line: string) => void;
  onExit?: (status: ShellTaskStatus, exitCode: number) => void;
};

type PtySession = {
  pid: number;
  command: string;
  process: PtyBridge;
  terminal: Terminal;
  alive: boolean;
  exitCode?: number;
  lastActivity: number;
  writeQueue: Promise<void>;
  expires: ReturnType<typeof setTimeout>;
  disposables: Array<{ dispose(): void }>;
};

type BackgroundOptions = {
  cwd?: string;
  signal?: AbortSignal;
  kind?: "bash" | "monitor";
  onStdoutLine?(line: string): void;
  onExit?(status: ShellTaskStatus, exitCode: number): void;
};

type PtyStartOptions = {
  cwd?: string;
  signal?: AbortSignal;
  command: string;
  cols?: number;
  rows?: number;
  waitMs?: number;
  idleMs?: number;
};

type Disposable = { dispose(): void };

type PtyBridge = {
  readonly pid: number;
  readonly closed: Promise<void>;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number }) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export class ShellSessionManager {
  #cwd: string;
  readonly #env: Record<string, string | undefined>;
  readonly #outputDir: string;
  readonly #sandbox: SandboxRuntime | undefined;
  readonly #tasks = new Map<string, BackgroundTask>();
  readonly #taskIdsByPid = new Map<number, string>();
  readonly #ptySessions = new Map<number, PtySession>();
  readonly #sandboxProbes = new Map<string, Promise<void>>();
  readonly #lifetime = new AbortController();
  readonly #operations = new Set<Promise<unknown>>();
  readonly #closingPtys = new Set<Promise<void>>();
  #closing: Promise<void> | undefined;
  #pendingPtys = 0;
  #targetRevision = 0;
  get targetRevision(): number { return this.#targetRevision; }

  constructor(options: {
    cwd: string;
    outputDir: string;
    env?: Record<string, string | undefined>;
    sandbox?: SandboxRuntime | undefined;
  }) {
    this.#cwd = options.cwd;
    this.#outputDir = options.outputDir;
    this.#env = Object.freeze({ ...(options.env ?? process.env) });
    this.#sandbox = options.sandbox;
  }

  setCwd(cwd: string): void {
    this.#cwd = cwd;
  }

  get cwd(): string {
    return this.#cwd;
  }

  get environment(): Record<string, string | undefined> { return { ...this.#env }; }

  captureCwd(): string { return realpathSync(this.#cwd); }

  async runForeground(
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
    onProgress?: ToolProgressReporter,
    cwd = this.#cwd,
  ): Promise<string> {
    return this.#own(() => this.#runForeground(command, timeoutMs,
      AbortSignal.any([signal, this.#lifetime.signal]), onProgress, cwd));
  }

  async #runForeground(command: string, timeoutMs: number, signal: AbortSignal,
    onProgress: ToolProgressReporter | undefined, cwd: string): Promise<string> {
    signal.throwIfAborted();
    await this.#ensureSandbox(cwd);
    signal.throwIfAborted();
    const child = this.#spawnChild(command, cwd);
    let stdout = "";
    let stderr = "";
    let liveOutput = "";
    const startedAt = Date.now();
    const report = () => onProgress?.({
      output: liveOutput,
      fullOutput: liveOutput,
      elapsedTimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      totalLines: countOutputLines(liveOutput),
      totalBytes: Buffer.byteLength(liveOutput, "utf8"),
      timeoutMs,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      liveOutput += chunk;
      report();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      liveOutput += chunk;
      report();
    });
    const progressTimer = onProgress ? setInterval(report, 1_000) : undefined;
    progressTimer?.unref?.();

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killChildTree(child);
    }, timeoutMs);
    const abort = () => killChildTree(child);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const exitCode = await childExit(child);
      if (signal.aborted) throw signal.reason ?? new Error("Command was interrupted");
      if (timedOut) throw new Error(`Command timed out after ${timeoutMs}ms`);
      const output = formatCommandOutput(stdout, stderr);
      if (exitCode !== 0) throw new Error(output || `Command exited with code ${exitCode}`);
      return output || "Command completed successfully with no output";
    } finally {
      clearTimeout(timeout);
      if (progressTimer) clearInterval(progressTimer);
      signal.removeEventListener("abort", abort);
    }
  }

  async runBackground(command: string, options: BackgroundOptions = {}): Promise<ShellTaskSnapshot> {
    const bound = { ...options, cwd: options.cwd ?? this.#cwd,
      signal: options.signal ? AbortSignal.any([options.signal, this.#lifetime.signal]) : this.#lifetime.signal };
    return this.#own(() => this.#runBackground(command, bound));
  }

  async #runBackground(command: string, options: BackgroundOptions): Promise<ShellTaskSnapshot> {
    const cwd = options.cwd!;
    options.signal?.throwIfAborted();
    await mkdir(this.#outputDir, { recursive: true });
    await this.#ensureSandbox(cwd);
    options.signal?.throwIfAborted();
    const id = `${options.kind ?? "bash"}_${randomUUID().slice(0, 8)}`;
    const outputPath = join(this.#outputDir, `${id}.log`);
    const writer = createWriteStream(outputPath, { flags: "a", encoding: "utf8" });
    const child = this.#spawnChild(command, cwd);
    const task: BackgroundTask = {
      id,
      pid: child.pid ?? 0,
      command,
      process: child,
      status: "running",
      output: "",
      outputBytes: 0,
      outputPath,
      writer,
      result: Promise.resolve(),
      lineBuffer: "",
      ...(options.onStdoutLine ? { onStdoutLine: options.onStdoutLine } : {}),
      ...(options.onExit ? { onExit: options.onExit } : {}),
    };
    if (!task.pid) {
      writer.end();
      throw new Error("Background command did not expose a process id");
    }
    this.#tasks.set(id, task);
    this.#targetRevision++;
    this.#taskIdsByPid.set(task.pid, id);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#appendTaskOutput(task, chunk, true));
    child.stderr.on("data", (chunk: string) => this.#appendTaskOutput(task, chunk));
    task.result = childExit(child).then((exitCode) => {
      if (task.lineBuffer) task.onStdoutLine?.(task.lineBuffer);
      task.lineBuffer = "";
      task.exitCode = exitCode;
      task.status = task.status === "killed" ? "killed" : exitCode === 0 ? "completed" : "failed";
      task.onExit?.(task.status, exitCode);
      writer.end();
    });
    return snapshotTask(task);
  }

  task(idOrPid: string | number): ShellTaskSnapshot {
    return snapshotTask(this.#requireTask(idOrPid));
  }

  runtimeSnapshots(): ShellRuntimeSnapshot[] {
    return [
      ...[...this.#tasks.values()].map((task) => ({ kind: "background" as const, ...snapshotTask(task) })),
      ...[...this.#ptySessions.values()].map((session) => ({ kind: "pty" as const, ...this.#snapshotPty(session) })),
    ];
  }

  async startPty(options: PtyStartOptions): Promise<PtySnapshot> {
    const bound = { ...options, cwd: options.cwd ?? this.#cwd,
      signal: options.signal ? AbortSignal.any([options.signal, this.#lifetime.signal]) : this.#lifetime.signal };
    if (this.#ptySessions.size + this.#pendingPtys >= MAX_PTY_SESSIONS) {
      throw new Error(`At most ${MAX_PTY_SESSIONS} PTY sessions may be active`);
    }
    this.#pendingPtys++;
    try { return await this.#own(() => this.#startPty(bound)); }
    finally { this.#pendingPtys--; }
  }

  async #startPty(options: PtyStartOptions): Promise<PtySnapshot> {
    if (this.#ptySessions.size >= MAX_PTY_SESSIONS) {
      throw new Error(`At most ${MAX_PTY_SESSIONS} PTY sessions may be active`);
    }
    const cols = positiveDimension(options.cols, DEFAULT_PTY_COLS, "cols");
    const rows = positiveDimension(options.rows, DEFAULT_PTY_ROWS, "rows");
    const cwd = options.cwd ?? this.#cwd;
    await this.#ensureSandbox(cwd);
    options.signal?.throwIfAborted();
    const shell = resolveShell(this.#env);
    const executable = this.#wrapExecutable(shell.file, shell.args(options.command), cwd);
    const process = await spawnPtyBridge({
      file: executable.file,
      args: executable.args,
      cols,
      rows,
      cwd,
      env: this.#env,
      signal: options.signal,
    });
    if (options.signal?.aborted) { process.kill(); await process.closed; options.signal.throwIfAborted(); }
    const terminal = new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true });
    const session: PtySession = {
      pid: process.pid,
      command: options.command,
      process,
      terminal,
      alive: true,
      lastActivity: Date.now(),
      writeQueue: Promise.resolve(),
      expires: setTimeout(() => undefined, PTY_SESSION_TTL_MS),
      disposables: [],
    };
    const initialActivity = session.lastActivity;
    this.#refreshPtyExpiry(session);
    session.disposables.push(
      process.onData((data) => {
        session.lastActivity = Date.now();
        this.#refreshPtyExpiry(session);
        session.writeQueue = session.writeQueue.then(
          () => new Promise<void>((resolve) => terminal.write(data, resolve)),
        );
      }),
      process.onExit(({ exitCode }) => {
        session.alive = false;
        session.exitCode = exitCode;
        session.lastActivity = Date.now();
      }),
    );
    this.#ptySessions.set(session.pid, session);
    this.#targetRevision++;
    await this.#waitForPty(session, options.waitMs, options.idleMs, initialActivity);
    options.signal?.throwIfAborted();
    return this.#snapshotPty(session);
  }

  async writePty(options: {
    pid: number;
    chars: string;
    submit?: boolean;
    waitMs?: number;
    idleMs?: number;
  }): Promise<PtySnapshot> {
    const session = this.#requirePty(options.pid, true);
    const previousActivity = session.lastActivity;
    this.#refreshPtyExpiry(session);
    session.process.write(decodePtyInput(options.chars));
    if (options.submit) session.process.write("\r");
    await this.#waitForPty(session, options.waitMs, options.idleMs, previousActivity);
    return this.#snapshotPty(session);
  }

  async readPty(options: {
    pid: number;
    lines?: number;
    waitMs?: number;
    idleMs?: number;
  }): Promise<PtySnapshot> {
    const session = this.#requirePty(options.pid, false);
    this.#refreshPtyExpiry(session);
    await this.#waitForPty(session, options.waitMs, options.idleMs, session.lastActivity);
    return this.#snapshotPty(session, options.lines);
  }

  async resizePty(options: {
    pid: number;
    cols: number;
    rows: number;
    waitMs?: number;
    idleMs?: number;
  }): Promise<PtySnapshot> {
    const session = this.#requirePty(options.pid, true);
    const previousActivity = session.lastActivity;
    const cols = positiveDimension(options.cols, undefined, "cols");
    const rows = positiveDimension(options.rows, undefined, "rows");
    this.#refreshPtyExpiry(session);
    session.process.resize(cols, rows);
    session.terminal.resize(cols, rows);
    session.lastActivity = Date.now();
    await this.#waitForPty(session, options.waitMs, options.idleMs, previousActivity);
    return this.#snapshotPty(session);
  }

  kill(idOrPid: string | number): string {
    if (typeof idOrPid === "number" && this.#ptySessions.has(idOrPid)) {
      this.closePty(idOrPid);
      return `Stopped PTY session ${idOrPid}`;
    }
    const task = this.#requireTask(idOrPid);
    if (task.status !== "running") return `Background task ${task.id} is already ${task.status}`;
    task.status = "killed";
    killChildTree(task.process);
    return `Stopped background task ${task.id}`;
  }

  closePty(pid: number): void {
    const session = this.#ptySessions.get(pid);
    if (!session) return;
    clearTimeout(session.expires);
    this.#closingPtys.add(session.process.closed);
    void session.process.closed.finally(() => { this.#closingPtys.delete(session.process.closed); });
    if (session.alive) {
      try {
        session.process.kill();
      } catch {
        // The PTY may already have closed between the state check and signal.
      }
    }
    for (const disposable of session.disposables) disposable.dispose();
    session.terminal.dispose();
    this.#ptySessions.delete(pid);
    this.#targetRevision++;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#lifetime.abort(new Error("Shell runtime is closing; new commands are not admitted"));
    this.#closing = (async () => {
      for (const task of this.#tasks.values()) {
        if (task.status === "running") { task.status = "killed"; killChildTree(task.process); }
      }
      for (const pid of [...this.#ptySessions.keys()]) this.closePty(pid);
      await Promise.allSettled([...this.#operations]);
      for (const pid of [...this.#ptySessions.keys()]) this.closePty(pid);
      await Promise.allSettled([...this.#tasks.values()].map((task) => task.result));
      await Promise.all([...this.#closingPtys]);
    })();
    return this.#closing;
  }

  #own<T>(operation: () => Promise<T>): Promise<T> {
    this.#lifetime.signal.throwIfAborted();
    const pending = Promise.resolve().then(() => { this.#lifetime.signal.throwIfAborted(); return operation(); });
    this.#operations.add(pending);
    void pending.finally(() => { this.#operations.delete(pending); }).catch(() => undefined);
    return pending;
  }

  #spawnChild(command: string, cwd: string): ChildProcessWithoutNullStreams {
    const shell = resolveShell(this.#env);
    const executable = this.#wrapExecutable(shell.file, shell.args(command), cwd);
    return spawnChild(executable.file, executable.args, {
      cwd,
      env: this.#env as NodeJS.ProcessEnv,
      detached: platform() !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  async #ensureSandbox(cwd: string): Promise<void> {
    if (!this.#sandbox) return;
    let probe = this.#sandboxProbes.get(cwd);
    if (!probe) {
      probe = probeSandboxRuntime(this.#sandbox, cwd, this.#env, this.#lifetime.signal);
      this.#sandboxProbes.set(cwd, probe);
    }
    await probe;
  }

  #wrapExecutable(file: string, args: string[], cwd: string): { file: string; args: string[] } {
    return this.#sandbox?.wrap(file, args, cwd) ?? { file, args };
  }

  #appendTaskOutput(task: BackgroundTask, chunk: string, notify = false): void {
    task.outputBytes += Buffer.byteLength(chunk, "utf8");
    if (task.outputBytes > MAX_TASK_OUTPUT_BYTES) {
      task.status = "killed";
      killChildTree(task.process);
      return;
    }
    task.writer.write(chunk);
    task.output = `${task.output}${chunk}`.slice(-TASK_OUTPUT_CHARS);
    if (notify && task.onStdoutLine) {
      const lines = `${task.lineBuffer}${chunk}`.split(/\r?\n/);
      task.lineBuffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) task.onStdoutLine(line);
    }
  }

  #requireTask(idOrPid: string | number): BackgroundTask {
    const id = typeof idOrPid === "number" ? this.#taskIdsByPid.get(idOrPid) : idOrPid;
    const task = id ? this.#tasks.get(id) : undefined;
    if (!task) throw new Error(`Unknown background task: ${idOrPid}`);
    return task;
  }

  #requirePty(pid: number, live: boolean): PtySession {
    const session = this.#ptySessions.get(pid);
    if (!session) throw new Error(`Unknown PTY session: ${pid}`);
    if (live && !session.alive) throw new Error(`PTY session ${pid} has exited`);
    return session;
  }

  async #waitForPty(
    session: PtySession,
    waitMs: number | undefined,
    idleMs: number | undefined,
    previousActivity: number,
  ): Promise<void> {
    const maximum = nonNegativeDuration(waitMs, DEFAULT_PTY_WAIT_MS, "wait_ms");
    const stable = nonNegativeDuration(idleMs, DEFAULT_PTY_IDLE_MS, "idle_ms");
    const started = Date.now();
    while (Date.now() - started < maximum) {
      await session.writeQueue;
      if (!session.alive || (
        session.lastActivity > previousActivity &&
        Date.now() - session.lastActivity >= stable
      )) return;
      await delay(Math.min(20, Math.max(1, maximum - (Date.now() - started))));
    }
    await session.writeQueue;
  }

  #refreshPtyExpiry(session: PtySession): void {
    clearTimeout(session.expires);
    session.expires = setTimeout(() => this.closePty(session.pid), PTY_SESSION_TTL_MS);
    session.expires.unref?.();
  }

  #snapshotPty(session: PtySession, lines?: number): PtySnapshot {
    const buffer = session.terminal.buffer.active;
    const count = lines === undefined
      ? session.terminal.rows
      : positiveDimension(lines, undefined, "lines");
    const start = Math.max(buffer.viewportY, buffer.viewportY + session.terminal.rows - count);
    const screen: string[] = [];
    for (let index = start; index < buffer.viewportY + session.terminal.rows; index += 1) {
      screen.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    while (screen.length && !screen.at(-1)) screen.pop();
    return {
      pid: session.pid,
      command: session.command,
      alive: session.alive,
      ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
      cols: session.terminal.cols,
      rows: session.terminal.rows,
      screen: screen.join("\n"),
    };
  }
}

function countOutputLines(output: string): number {
  if (!output) return 0;
  const lines = output.split(/\r?\n/);
  return output.endsWith("\n") ? lines.length - 1 : lines.length;
}

async function spawnPtyBridge(options: {
  file: string;
  args: string[];
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}): Promise<PtyBridge> {
  options.signal?.throwIfAborted();
  const moduleUrl = import.meta.resolve("@lydell/node-pty");
  const modulePath = moduleUrl.startsWith("file:") ? fileURLToPath(moduleUrl) : moduleUrl;
  const node = options.env.TNB_NODE_PATH ?? "node";
  const host = spawnChild(node, ["-e", PTY_HOST_SOURCE], {
    cwd: options.cwd,
    env: {
      ...options.env,
      TNB_PTY_MODULE: modulePath,
      TNB_PTY_FILE: options.file,
      TNB_PTY_ARGS: JSON.stringify(options.args),
      TNB_PTY_COLS: String(options.cols),
      TNB_PTY_ROWS: String(options.rows),
      TNB_PTY_CWD: options.cwd,
    } as NodeJS.ProcessEnv,
    detached: platform() !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolve) => { host.once("close", () => resolve()); });
  const terminateHost = () => killChildTree(host);
  host.stdout.setEncoding("utf8");
  host.stderr.setEncoding("utf8");
  let stderr = "";
  host.stderr.on("data", (chunk: string) => void (stderr += chunk));
  let buffered = "";
  let ptyPid = 0;
  let exited = false;
  let exitEvent: { exitCode: number } | undefined;
  const pendingData: string[] = [];
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  let resolveStarted!: () => void;
  let rejectStarted!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const startupTimeout = setTimeout(
    () => rejectStarted(new Error("PTY host did not start within 10 seconds")),
    10_000,
  );
  host.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      let event: PtyHostEvent;
      try {
        event = JSON.parse(line) as PtyHostEvent;
      } catch {
        rejectStarted(new Error(`PTY host emitted invalid protocol data: ${line}`));
        continue;
      }
      if (event.type === "started") {
        ptyPid = event.pid;
        clearTimeout(startupTimeout);
        resolveStarted();
      } else if (event.type === "data") {
        const data = Buffer.from(event.data, "base64").toString("utf8");
        if (dataListeners.size === 0) pendingData.push(data);
        else for (const listener of dataListeners) listener(data);
      } else if (event.type === "exit") {
        exited = true;
        exitEvent = { exitCode: event.exitCode };
        for (const listener of exitListeners) listener(exitEvent);
      } else if (event.type === "error") {
        rejectStarted(new Error(event.message));
      }
    }
  });
  host.once("error", (error) => rejectStarted(error));
  host.once("exit", (code) => {
    clearTimeout(startupTimeout);
    if (!ptyPid) {
      rejectStarted(new Error(stderr.trim() || `PTY host exited with code ${code ?? 1}`));
    } else if (!exited) {
      for (const listener of exitListeners) listener({ exitCode: code ?? 1 });
    }
  });
  const abortStartup = () => {
    rejectStarted(options.signal?.reason ?? new Error("PTY startup cancelled"));
    terminateHost();
  };
  options.signal?.addEventListener("abort", abortStartup, { once: true });
  if (options.signal?.aborted) abortStartup();
  try {
    await started;
  } catch (error) {
    terminateHost();
    await closed;
    throw error;
  } finally {
    clearTimeout(startupTimeout);
    options.signal?.removeEventListener("abort", abortStartup);
  }

  const send = (message: Record<string, unknown>) => {
    if (!host.stdin.destroyed) host.stdin.write(`${JSON.stringify(message)}\n`);
  };
  return {
    pid: ptyPid,
    closed,
    onData(listener) {
      dataListeners.add(listener);
      for (const data of pendingData.splice(0)) listener(data);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit(listener) {
      exitListeners.add(listener);
      if (exitEvent) listener(exitEvent);
      return { dispose: () => exitListeners.delete(listener) };
    },
    write(data) {
      send({ type: "write", data: Buffer.from(data).toString("base64") });
    },
    resize(cols, rows) {
      send({ type: "resize", cols, rows });
    },
    kill() {
      send({ type: "kill" });
      setTimeout(() => {
        if (host.exitCode === null && host.signalCode === null) terminateHost();
      }, 250).unref();
    },
  };
}

type PtyHostEvent =
  | { type: "started"; pid: number }
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number }
  | { type: "error"; message: string };

const PTY_HOST_SOURCE = String.raw`
const readline = require("node:readline");
const { spawn } = require(process.env.TNB_PTY_MODULE);
const args = JSON.parse(process.env.TNB_PTY_ARGS || "[]");
const reserved = new Set([
  "TNB_PTY_MODULE", "TNB_PTY_FILE", "TNB_PTY_ARGS",
  "TNB_PTY_COLS", "TNB_PTY_ROWS", "TNB_PTY_CWD"
]);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !reserved.has(key)));
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
let terminal;
process.on("exit", () => { try { terminal?.kill("SIGKILL"); } catch {} });
process.on("SIGTERM", () => { try { terminal?.kill("SIGKILL"); } catch {} process.exit(0); });
try {
  terminal = spawn(process.env.TNB_PTY_FILE, args, {
    name: "xterm-256color",
    cols: Number(process.env.TNB_PTY_COLS),
    rows: Number(process.env.TNB_PTY_ROWS),
    cwd: process.env.TNB_PTY_CWD,
    env
  });
} catch (error) {
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
emit({ type: "started", pid: terminal.pid });
terminal.onData((data) => emit({ type: "data", data: Buffer.from(data).toString("base64") }));
terminal.onExit(({ exitCode }) => {
  emit({ type: "exit", exitCode });
  setTimeout(() => process.exit(0), 20);
});
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("close", () => {
  try { terminal.kill("SIGKILL"); } catch {}
  setTimeout(() => process.exit(0), 100);
}).on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (message.type === "write") terminal.write(Buffer.from(message.data, "base64").toString("utf8"));
    else if (message.type === "resize") terminal.resize(message.cols, message.rows);
    else if (message.type === "kill") terminal.kill("SIGKILL");
  } catch (error) {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
});
`;

function resolveShell(env: Record<string, string | undefined>): {
  file: string;
  args(command: string): string[];
} {
  return resolveShellInvocation(env, platform());
}

function snapshotTask(task: BackgroundTask): ShellTaskSnapshot {
  return {
    taskId: task.id,
    pid: task.pid,
    command: task.command,
    status: task.status,
    ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
    output: task.output,
    outputPath: task.outputPath,
  };
}

function formatCommandOutput(stdout: string, stderr: string): string {
  return [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");
}

function childExit(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal === "SIGTERM" ? 143 : 1)));
  });
}

function killChildTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) return;
  if (!terminations.has(child)) {
    const timer = setTimeout(() => {
      terminations.delete(child);
      // A group member can keep inherited pipes open after the leader exits.
      // On Unix, close (which clears this timer) is the drain boundary.
      if (platform() === "win32" && (child.exitCode !== null || child.signalCode !== null)) return;
      try {
        if (platform() === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid!, "SIGKILL");
      } catch { try { child.kill("SIGKILL"); } catch { /* Already gone. */ } }
    }, 250);
    timer.unref();
    terminations.set(child, timer);
    child.once("close", () => { clearTimeout(timer); terminations.delete(child); });
  }
  try {
    if (platform() === "win32") child.kill();
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill();
    } catch {
      // Process already exited.
    }
  }
}

const terminations = new WeakMap<ChildProcessWithoutNullStreams, ReturnType<typeof setTimeout>>();

function positiveDimension(value: number | undefined, fallback: number | undefined, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || (resolved ?? 0) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved as number;
}

function nonNegativeDuration(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) throw new Error(`${name} must be non-negative`);
  return resolved;
}

function decodePtyInput(value: string): string {
  return value
    .replaceAll("\\e", "\u001b")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replaceAll("\\r", "\r")
    .replaceAll("\\n", "\n")
    .replaceAll("\\t", "\t");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
