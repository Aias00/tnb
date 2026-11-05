import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile, unlink, lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { digestJson } from "./json";
import { DurableRuntime, type RuntimeConfiguration } from "./engine-core";
import { RuntimeStore } from "./store";
import { loadDefaultProfile } from "../../profiles/default";
import type { ContributionReference } from "../../agent/extensions";
import { DomainRegistry } from "../../agent/domain";
import { lock } from "../../utils/lockfile";
import { questionAttentionResponse } from "./attention-stream";
import type { RoutingInput, RoutingDecision } from "./routing";
import { presentRunDetail, presentRuns } from "./presentation";
const COLLABORATION_EXTENSION: ContributionReference = { kind: "application", id: "collaboration", version: "1" };

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
  readOnlyDelegation: true, parallelWrites: false, skills: true, mcp: true, durableCapabilityPolicy: "explicit-selection-host-allowlist-v1", remoteFederation: false, offlineBackup: true, conversationHandoff: true,
  durableWaits: true, durableDelegation: true, deadlineScheduling: true, questionNotifications: true, lifecycleNotifications: true, adjustableLimits: true,
  taskRouting: true, safeFollowups: true, delegationStrategyVersion: 2, defaultDelegationDepth: 1, autoParallelBranches: 2,
  structuredChildReports: true, machineModelCoordination: true, overlappingWorkspaceLocks: true,
  domainAdapters: true, codingPlugin: true, pluginInventory: true, collaborationProfile: true, hostPluginExtensions: true });
export async function serveDurableRuntime(options: ServerOptions): Promise<void> {
  const paths = await runtimePaths(options.configDir);
  const release = await lock(paths.root, { realpath: true, stale: 5000, update: 1000, retries: 0 });
  try { await serveLockedRuntime(options); } finally { await release(); }
}
async function serveLockedRuntime(options: ServerOptions): Promise<void> {
  const paths = await runtimePaths(options.configDir);
  const profile = await loadDefaultProfile({ ...options, root: paths.root, coding: !options.runtime });
  const plugins = profile.plugins;
  const { store, runtime } = options.runtime ? { store: options.runtime.store, runtime: options.runtime }
    : await (async () => { try { return composeRuntime(paths.root, plugins); } catch (error) { await plugins.close(); throw error; } })();
  let server: ReturnType<typeof Bun.serve> | undefined;
  let closing = false;
  let ready = false;
  const stopped = Promise.withResolvers<void>();
  const stopping = new AbortController();
  const lifetime = AbortSignal.any([options.signal, stopping.signal]);
  let started = false;
  let commandTail = Promise.resolve();
  async function serialCommand<T>(apply: () => Promise<T>): Promise<T> {
    if (closing) throw new Error("Runtime is stopping");
    const previous = commandTail; const finished = Promise.withResolvers<void>();
    commandTail = previous.catch(() => undefined).then(() => finished.promise);
    await previous.catch(() => undefined);
    try { if (closing) throw new Error("Runtime is stopping"); return await apply(); } finally { finished.resolve(); }
  }
  try {
    await runtime.start(async () => {}); started = true;
    const token = randomBytes(32).toString("hex");
    await writeFile(paths.token, token, { mode: 0o600 }); await chmod(paths.token, 0o600);
    // Only the lock owner removes a stale socket. A second daemon fails before reaching this point.
    await unlink(paths.socket).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    server = Bun.serve({ unix: paths.socket, maxRequestBodySize: 256 * 1024,
      async fetch(request) {
        if (closing) return Response.json({ error: "Runtime is stopping" }, { status: 503 });
        const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        const suppliedBytes = Buffer.from(supplied); const tokenBytes = Buffer.from(token);
        if (suppliedBytes.length !== tokenBytes.length || !timingSafeEqual(suppliedBytes, tokenBytes)) return Response.json({ error: "Unauthorized" }, { status: 403 });
        try {
          const url = new URL(request.url);
          if (url.pathname === "/collaboration") {
            if (!plugins.extensions.list().some(item => item.kind === "application" && item.id === "collaboration" && item.version === "1" && item.status === "active")) return request.method === "GET" ? Response.json({ enabled: false }) : Response.json({ error: "Collaboration application is unavailable" }, { status: 400 });
            return await (request.method === "GET" ? plugins.extensions.handle(COLLABORATION_EXTENSION, request) : serialCommand(() => plugins.extensions.handle(COLLABORATION_EXTENSION, request)));
          }
          if (url.pathname === "/extensions") return Response.json(plugins.extensions.list());
          const extension = /^\/extensions\/(application|interface)\/([^/]+)\/([^/]+)(?:\/.*)?$/.exec(url.pathname);
          if (extension) {
            const ref: ContributionReference = { kind: extension[1] as "application" | "interface", id: decodeURIComponent(extension[2]!), version: decodeURIComponent(extension[3]!) };
            return await (request.method === "GET" ? plugins.extensions.handle(ref, request) : serialCommand(() => plugins.extensions.handle(ref, request)));
          }
          if (url.pathname === "/plugins") return Response.json(plugins?.list() ?? []);
          if (request.method === "GET") {
            if (url.pathname === "/presentation") {
              const workspace = await realpath(url.searchParams.get("workspace") ?? ""); const runId = url.searchParams.get("runId");
              if (!runId) return Response.json(presentRuns(runtime, workspace));
              if (store.record<{ workspace: string }>("configuration", runId)?.value.workspace !== workspace) throw new Error("Task is outside the current workspace");
              return Response.json(await presentRunDetail(runtime, runId));
            }
            if (url.pathname === "/health") return Response.json({ ready: ready && !runtime.lastError, pid: process.pid, error: runtime.lastError, capabilities: RUNTIME_CAPABILITIES });
            if (url.pathname === "/routing") {
              const workspace = await realpath(url.searchParams.get("workspace") ?? "");
              if (url.searchParams.has("inputId")) {
                const decision = store.route<RoutingDecision>(url.searchParams.get("inputId")!);
                return Response.json(decision?.workspace === workspace ? [decision] : []);
              }
              return Response.json(store.routes(workspace, { pendingOnly: url.searchParams.get("pending") === "true", beforeInputId: url.searchParams.get("beforeInput") ?? undefined }));
            }
            if (url.pathname === "/attention") {
              const workspace = url.searchParams.get("workspace"); if (!workspace) throw new Error("Notification workspace is required");
              return questionAttentionResponse(runtime, workspace, request.signal);
            }
            if (url.pathname === "/runs") {
              const workspace = url.searchParams.get("workspace"); const sessionId = url.searchParams.get("sessionId");
              return Response.json(store.runs().filter((run) => {
                if (!workspace && !sessionId) return true;
                const config = store.record<RuntimeConfiguration>("configuration", run.runId)?.value;
                return (!workspace || config?.workspace === workspace) && (!sessionId || config?.originSessionId === sessionId);
              }));
            }
            const runId = url.searchParams.get("runId") ?? "";
            if (!store.getRun(runId)) throw new Error("Run not found");
            if (url.pathname === "/events") return Response.json(store.events(runId, Number(url.searchParams.get("after") ?? 0), 100));
            if (url.pathname === "/questions") return Response.json(runtime.waits.questions(runId));
            if (url.pathname === "/result") {
              const taskId = url.searchParams.get("taskId");
              const tasks = store.tasks(runId).filter((task) => taskId ? task.taskId === taskId : !task.parentTaskId);
              if (!tasks.length) throw new Error("Result task not found");
              return Response.json(await Promise.all(tasks.map(async (task) => ({ taskId: task.taskId, key: task.key, status: task.status,
                result: task.resultRef ? await runtime.artifacts.get(task.resultRef) : null }))));
            }
            if (url.pathname === "/status") return Response.json({ run: store.getRun(runId), tasks: store.tasks(runId), budget: runtime.budget.totals(runId),
              operations: store.operationHeaders(runId), questions: runtime.waits.questions(runId), waits: runtime.waits.pending(runId),
              limits: runtime.limits(runId) });
            throw new Error("Unknown runtime resource");
          }
          if (request.method !== "POST" || url.pathname !== "/command") throw new Error("Unknown runtime command endpoint");
          const input = await request.json() as { action: string; commandId: string; runId?: string; objective?: string;
            configuration?: RuntimeConfiguration; mode?: "single" | "auto" | "multi"; taskId?: string; operationId?: string; result?: string;
            waitId?: string; expectedVersion?: number; answer?: string; noticeId?: string; expectedRevision?: number;
            deadline?: number; extendMs?: number; maxCostUsd?: number; source?: RoutingInput; workspace?: string; text?: string; inputId?: string; resolveInputId?: string; successorOf?: string; routeAction?: string };
          return await serialCommand(async () => {
            if (typeof input.commandId !== "string" || !input.commandId) throw new Error("commandId is required");
            if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) throw new Error("Invalid expected Run revision");
            if (input.action === "stop") { closing = true; setTimeout(() => { stopping.abort(); stopped.resolve(); }, 20); return Response.json({ stopping: true }); }
            if (input.action === "route-control") {
              if (!input.source || await realpath(input.source.workspace) !== input.source.workspace) throw new Error("Canonical input source is required");
              return Response.json(runtime.router.clarifyControl({ commandId: input.commandId, source: input.source, action: input.routeAction! }));
            }
            if (input.action === "resolve-route") {
              const decision = store.route<RoutingDecision>(input.resolveInputId!);
              if (!decision || !input.source || decision.workspace !== input.source.workspace || decision.sessionId !== input.source.sessionId
                || !decision.candidates.some((candidate) => candidate.runId === input.runId)) throw new Error("Routing target is not in the original question scope");
              if (decision.status === "accepted" && decision.runId === input.runId && decision.revision === (input.expectedRevision ?? 0) + 1) return Response.json(decision);
              if (decision.status !== "clarify" || decision.revision !== input.expectedRevision || !["run.pause", "run.cancel", "run.resume"].includes(decision.action)) throw new Error("Routing decision changed; refresh before selecting");
              const run = store.getRun(input.runId!);
              if (!run || runtime.configuration(run.runId).workspace !== decision.workspace) throw new Error("Control target workspace changed");
              const source: RoutingInput = { inputId: decision.inputId, workspace: decision.workspace, rawText: decision.rawText, source: decision.source,
                sessionId: decision.sessionId, resolutionRevision: decision.revision };
              if (decision.action === "run.pause") runtime.commands.pauseRun({ commandId: input.commandId, runId: run.runId, expectedRevision: run.revision, source });
              else if (decision.action === "run.cancel") runtime.commands.cancelRun({ commandId: input.commandId, runId: run.runId, expectedRevision: run.revision, source });
              else await runtime.resume(run.runId, input.commandId, run.revision, source);
              return Response.json(store.route(decision.inputId));
            }
            if (input.action === "submit") return Response.json(await runtime.submit({ commandId: input.commandId, objective: input.objective!, configuration: { ...input.configuration!, strategyVersion: 2 }, mode: input.mode, deadline: input.deadline, source: input.source, successorOf: input.successorOf }));
            if (input.action === "followup") {
              const workspace = await realpath(input.workspace ?? input.source?.workspace ?? "");
              return Response.json(runtime.router.followup({ commandId: input.commandId, runId: input.runId, taskId: input.taskId,
                resolveInputId: input.resolveInputId, expectedRevision: input.expectedRevision,
                source: input.source ?? { inputId: input.inputId ?? input.commandId, workspace, rawText: input.text ?? "Resolve original input", source: "api" } }));
            }
            const run = input.runId && store.getRun(input.runId);
            if (!run) throw new Error("Run not found");
            const workspace = runtime.configuration(run.runId).workspace;
            const source: RoutingInput = input.source ?? { inputId: input.commandId, workspace, rawText: input.answer ?? `${input.action} ${run.runId}`, source: "api" };
            if (source.workspace !== workspace) throw new Error("Control input workspace mismatch");
            type Receipt = { digest: string; expectedRevision: number; result?: unknown };
            const digest = digestJson(input);
            const receipt = store.command(randomUUID(), { kind: "http.prepare", id: input.commandId, digest }, Date.now(), (tx) => {
              const previous = tx.record<Receipt>("http-command", input.commandId);
              if (previous) { if (previous.value.digest !== digest) throw new Error("HTTP command ID has conflicting input"); return previous.value; }
              const value: Receipt = { digest, expectedRevision: input.expectedRevision ?? run.revision };
              tx.saveRecord({ kind: "http-command", id: input.commandId, runId: run.runId, value }, 0); return value;
            });
            if (receipt.result) return Response.json(receipt.result);
            if (input.action === "ack") runtime.commands.acknowledgeNotice({ commandId: input.commandId, runId: run.runId, noticeId: input.noticeId! });
            else if (input.action === "limits") runtime.commands.updateLimits({ commandId: input.commandId, runId: run.runId,
              expectedRevision: receipt.expectedRevision, deadline: input.deadline, extendMs: input.extendMs, maxCostUsd: input.maxCostUsd, source });
            else if (input.action === "answer") runtime.waits.answer({ commandId: input.commandId, runId: run.runId,
              waitId: input.waitId!, expectedVersion: input.expectedVersion!, answer: input.answer!, source });
            else if (input.action === "pause") runtime.commands.pauseRun({ commandId: input.commandId, runId: run.runId, expectedRevision: receipt.expectedRevision, source });
            else if (input.action === "cancel") runtime.commands.cancelRun({ commandId: input.commandId, runId: run.runId, expectedRevision: receipt.expectedRevision, source });
            else if (input.action === "resume") await runtime.resume(run.runId, input.commandId, receipt.expectedRevision, source);
            else if (input.action === "reconcile") {
              if (store.getTask(input.taskId!)?.runId !== run.runId) throw new Error("Reconciliation task mismatch");
              await runtime.reconcile(input.taskId!, input.operationId!, input.result!);
            } else throw new Error("Unknown runtime action");
            await runtime.tick();
            const result = { run: store.getRun(run.runId), tasks: store.tasks(run.runId),
              limits: runtime.limits(run.runId), budget: runtime.budget.totals(run.runId) };
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
    await profile.start(runtime, lifetime);
    ready = true;
    options.ready?.(paths.socket);
    if (!options.signal.aborted) await Promise.race([stopped.promise, new Promise<void>((done) => options.signal.addEventListener("abort", () => done(), { once: true }))]);
  } finally {
    closing = true;
    try { try { try { await plugins.extensions.stop(); } finally { await commandTail; } } finally { if (started) await runtime.close(); } }
    finally {
      try { await plugins?.close(); }
      finally {
        try { await server?.stop(true); }
        finally { if (started) await unlink(paths.socket).catch(() => undefined); if (!options.runtime) store.close(); }
      }
    }
  }
}

/** Called only while the server owns the state-directory lock. */
function composeRuntime(root: string, plugins: Awaited<ReturnType<typeof loadDefaultProfile>>["plugins"]) {
  const store = new RuntimeStore(join(root, "state.sqlite"));
  return { store, runtime: new DurableRuntime(store, root, new DomainRegistry([], plugins.registrations, "coding")) };
}

export class RuntimeRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function runtimeRequest(configDir: string, resource: string, body?: unknown): Promise<unknown> {
  const paths = await runtimePaths(configDir); const token = (await readFile(paths.token, "utf8")).trim();
  const response = await fetch(`http://localhost${resource}`, { unix: paths.socket, method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
  const value = await response.json() as { error?: string };
  if (!response.ok) throw new RuntimeRequestError(value.error ?? `Runtime HTTP ${response.status}`, response.status);
  return value;
}
