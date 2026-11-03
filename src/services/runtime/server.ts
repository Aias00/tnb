import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile, unlink, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { digestJson } from "./json";
import { DurableRuntime, type RuntimeConfiguration } from "./engine";
import { RuntimeStore } from "./store";
import { createRuntimeWorkerFactory } from "./worker";
import { lock } from "../../utils/lockfile";

export async function runtimePaths(configDir: string): Promise<{ root: string; socket: string; token: string }> {
  const root = resolve(configDir, "runtime"); await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = join("/tmp", `tnb-runtime-${process.getuid?.() ?? "local"}-${digestJson(root).slice(0, 16)}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new Error("Unsafe runtime socket directory");
  return { root, socket: join(directory, "rpc.sock"), token: join(root, "control.key") };
}

type ServerOptions = { configDir: string; env: Record<string, string | undefined>; signal: AbortSignal; runtime?: DurableRuntime; ready?(socket: string): void };
export const RUNTIME_CAPABILITIES = Object.freeze({ protocol: 2, defaultMode: "auto", maxDelegationDepth: 2, maxParallelBranches: 4,
  readOnlyDelegation: true, parallelWrites: false, skills: false, mcp: false, remoteFederation: false, offlineBackup: true });
export async function serveDurableRuntime(options: ServerOptions): Promise<void> {
  const paths = await runtimePaths(options.configDir);
  const release = await lock(paths.root, { realpath: true, stale: 5000, update: 1000, retries: 0 });
  try { await serveLockedRuntime(options); } finally { await release(); }
}
async function serveLockedRuntime(options: ServerOptions): Promise<void> {
  const paths = await runtimePaths(options.configDir);
  const store = options.runtime?.store ?? new RuntimeStore(join(paths.root, "state.sqlite"));
  const runtime = options.runtime ?? new DurableRuntime(store, paths.root,
    createRuntimeWorkerFactory({ configDir: options.configDir, runtimeRoot: paths.root, env: options.env }));
  let server: ReturnType<typeof Bun.serve> | undefined;
  const stopped = Promise.withResolvers<void>();
  let started = false;
  let commandTail = Promise.resolve();
  async function serialCommand<T>(apply: () => Promise<T>): Promise<T> {
    const previous = commandTail; const finished = Promise.withResolvers<void>();
    commandTail = previous.catch(() => undefined).then(() => finished.promise);
    await previous.catch(() => undefined);
    try { return await apply(); } finally { finished.resolve(); }
  }
  try {
    await runtime.start(async () => {}); started = true;
    const token = randomBytes(32).toString("hex");
    await writeFile(paths.token, token, { mode: 0o600 }); await chmod(paths.token, 0o600);
    // Only the lock owner removes a stale socket. A second daemon fails before reaching this point.
    await unlink(paths.socket).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    server = Bun.serve({ unix: paths.socket, maxRequestBodySize: 256 * 1024,
      async fetch(request) {
        const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        const suppliedBytes = Buffer.from(supplied); const tokenBytes = Buffer.from(token);
        if (suppliedBytes.length !== tokenBytes.length || !timingSafeEqual(suppliedBytes, tokenBytes)) return Response.json({ error: "Unauthorized" }, { status: 403 });
        try {
          const url = new URL(request.url);
          if (request.method === "GET") {
            if (url.pathname === "/health") return Response.json({ ready: !runtime.lastError, pid: process.pid, error: runtime.lastError, capabilities: RUNTIME_CAPABILITIES });
            if (url.pathname === "/runs") return Response.json(store.runs());
            const runId = url.searchParams.get("runId") ?? "";
            if (!store.getRun(runId)) throw new Error("Run not found");
            if (url.pathname === "/events") return Response.json(store.events(runId, Number(url.searchParams.get("after") ?? 0), 100));
            if (url.pathname === "/result") {
              const taskId = url.searchParams.get("taskId");
              const tasks = store.tasks(runId).filter((task) => taskId ? task.taskId === taskId : !task.parentTaskId);
              if (!tasks.length) throw new Error("Result task not found");
              return Response.json(await Promise.all(tasks.map(async (task) => ({ taskId: task.taskId, key: task.key, status: task.status,
                result: task.resultRef ? await runtime.artifacts.get(task.resultRef) : null }))));
            }
            if (url.pathname === "/status") return Response.json({ run: store.getRun(runId), tasks: store.tasks(runId), budget: runtime.budget.totals(runId),
              operations: store.operationHeaders(runId) });
            throw new Error("Unknown runtime resource");
          }
          if (request.method !== "POST" || url.pathname !== "/command") throw new Error("Unknown runtime command endpoint");
          const input = await request.json() as { action: string; commandId: string; runId?: string; objective?: string;
            configuration?: RuntimeConfiguration; mode?: "single" | "auto" | "multi"; taskId?: string; operationId?: string; result?: string };
          return await serialCommand(async () => {
            if (typeof input.commandId !== "string" || !input.commandId) throw new Error("commandId is required");
            if (input.action === "stop") { setTimeout(() => stopped.resolve(), 20); return Response.json({ stopping: true }); }
            if (input.action === "submit") return Response.json(await runtime.submit({ commandId: input.commandId, objective: input.objective!, configuration: input.configuration!, mode: input.mode }));
            const run = input.runId && store.getRun(input.runId);
            if (!run) throw new Error("Run not found");
            type Receipt = { digest: string; expectedRevision: number; result?: unknown };
            const digest = digestJson(input);
            const receipt = store.command(randomUUID(), { kind: "http.prepare", id: input.commandId, digest }, Date.now(), (tx) => {
              const previous = tx.record<Receipt>("http-command", input.commandId);
              if (previous) { if (previous.value.digest !== digest) throw new Error("HTTP command ID has conflicting input"); return previous.value; }
              const value: Receipt = { digest, expectedRevision: run.revision };
              tx.saveRecord({ kind: "http-command", id: input.commandId, runId: run.runId, value }, 0); return value;
            });
            if (receipt.result) return Response.json(receipt.result);
            if (input.action === "pause") runtime.commands.pauseRun({ commandId: input.commandId, runId: run.runId, expectedRevision: receipt.expectedRevision });
            else if (input.action === "cancel") runtime.commands.cancelRun({ commandId: input.commandId, runId: run.runId, expectedRevision: receipt.expectedRevision });
            else if (input.action === "resume") await runtime.resume(run.runId, input.commandId, receipt.expectedRevision);
            else if (input.action === "reconcile") {
              if (store.getTask(input.taskId!)?.runId !== run.runId) throw new Error("Reconciliation task mismatch");
              await runtime.reconcile(input.taskId!, input.operationId!, input.result!);
            } else throw new Error("Unknown runtime action");
            await runtime.tick();
            const result = { run: store.getRun(run.runId), tasks: store.tasks(run.runId) };
            store.command(randomUUID(), { kind: "http.result", id: input.commandId }, Date.now(), (tx) => {
              const current = tx.record<Receipt>("http-command", input.commandId)!;
              tx.saveRecord({ ...current, value: { ...current.value, result } }, current.revision); return true;
            });
            return Response.json(result);
          });
        } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
      },
    });
    await chmod(paths.socket, 0o600);
    options.ready?.(paths.socket);
    if (!options.signal.aborted) await Promise.race([stopped.promise, new Promise<void>((done) => options.signal.addEventListener("abort", () => done(), { once: true }))]);
  } finally {
    try { if (started) await runtime.close(); }
    finally {
      try { await server?.stop(true); }
      finally { if (started) await unlink(paths.socket).catch(() => undefined); if (!options.runtime) store.close(); }
    }
  }
}

export async function runtimeRequest(configDir: string, resource: string, body?: unknown): Promise<unknown> {
  const paths = await runtimePaths(configDir); const token = (await readFile(paths.token, "utf8")).trim();
  const response = await fetch(`http://localhost${resource}`, { unix: paths.socket, method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
  const value = await response.json() as { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Runtime HTTP ${response.status}`);
  return value;
}
