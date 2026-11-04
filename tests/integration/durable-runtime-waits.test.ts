// Waiting must survive owner loss without keeping an attempt or workspace lease alive;
// answers are versioned and idempotent, and no business tool may follow a yield in the same batch.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableRuntime, type RuntimeConfiguration, type RuntimeWorkerFactory } from "../../src/services/runtime/engine";
import { RuntimeStore } from "../../src/services/runtime/store";
import { acquireWorkspace, workspaceIsLocked } from "../../src/services/runtime/workspace";
import { createWriteTool } from "../../src/tools/builtins";
import type { ModelTransport } from "../../src/providers/types";

const roots: string[] = [], runtimes: DurableRuntime[] = [], stores: RuntimeStore[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(transport: ModelTransport) {
  const root = await mkdtemp(join(tmpdir(), "tnb-durable-wait-")); roots.push(root);
  const workspace = join(root, "work"); await mkdir(workspace);
  const state = join(root, "control", "runtime"), db = join(state, "state.sqlite");
  const store = new RuntimeStore(db); stores.push(store);
  const factory: RuntimeWorkerFactory = async () => ({ transport, model: "fixture", tools: [createWriteTool(workspace)],
    authorize: async () => ({ behavior: "allow" }), route: { provider: "fixture", model: "fixture" }, maxOutputTokens: 100,
    check: async () => "passed" });
  const runtime = new DurableRuntime(store, state, factory); runtimes.push(runtime); await runtime.start();
  const config: RuntimeConfiguration = { workspace, allowedWorkspaces: [workspace], allowWrite: false, allowShell: false,
    checks: [], maxTurns: 10, maxRetries: 0, compactThreshold: 10000 };
  return { root, workspace, state, db, store, runtime, factory, config };
}
async function until(runtime: DurableRuntime, predicate: () => boolean) {
  const end = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Wait condition timed out: ${runtime.lastError}; ${JSON.stringify(runtime.store.runs())}`);
    await runtime.tick(); await Bun.sleep(10);
  }
}
async function* call(name: string, input: unknown, id = name) {
  yield { type: "tool-start" as const, index: 0, id, name };
  yield { type: "tool-input" as const, index: 0, json: JSON.stringify(input) };
  yield { type: "response-end" as const, reason: "tool-use" as const };
}
async function* report() {
  yield { type: "text" as const, index: 0, text: "Accepted deliverable" };
  yield { type: "response-end" as const, reason: "end-turn" as const };
}

test("a question releases its attempt and workspace; restart delivers a versioned answer once", async () => {
  let calls = 0;
  const f = await fixture({ async *stream(request) {
    if (++calls === 1) yield* call("durable_wait", { kind: "question", key: "storage", question: "选择数据库", options: ["SQLite", "其他"], about: "根据答案继续设计，不重做调研" });
    else { expect(JSON.stringify(request.messages)).toContain("SQLite"); yield* report(); }
  } });
  const { run, tasks } = await f.runtime.submit({ commandId: "question", objective: "Design storage", configuration: f.config, mode: "single" });
  await until(f.runtime, () => f.store.getTask(tasks[0]!.taskId)?.status === "waiting");
  await until(f.runtime, () => f.store.activeAttempts(run.runId).length === 0);
  await Bun.sleep(30); expect(await workspaceIsLocked(f.workspace)).toBe(false);
  expect(calls).toBe(1); expect(f.store.getRun(run.runId)?.status).toBe("active");
  const question = f.runtime.waits.questions(run.runId)[0]!;
  await f.runtime.close(); f.store.close();
  const store = new RuntimeStore(f.db); stores.push(store);
  const runtime = new DurableRuntime(store, f.state, f.factory); runtimes.push(runtime); await runtime.start();
  expect(calls).toBe(1); expect(runtime.waits.questions(run.runId)).toHaveLength(1);
  expect(() => runtime.waits.answer({ commandId: "stale", runId: run.runId, waitId: question.waitId, expectedVersion: question.version + 1, answer: "SQLite" })).toThrow("version");
  const answer = { runId: run.runId, waitId: question.waitId, expectedVersion: question.version, answer: "SQLite" };
  runtime.waits.answer({ commandId: "answer", ...answer });
  runtime.waits.answer({ commandId: "answer-again", ...answer });
  expect(() => runtime.waits.answer({ commandId: "conflict", ...answer, answer: "其他" })).toThrow("answered");
  await until(runtime, () => store.getRun(run.runId)?.status === "succeeded");
  expect(calls).toBe(2); expect(store.tasks(run.runId)[0]!.taskId).toBe(tasks[0]!.taskId);
  expect(store.events(run.runId).filter((event) => event.type === "wait.answered")).toHaveLength(1);
});

test("a durable yield blocks later business calls in the same model batch", async () => {
  const f = await fixture({ async *stream() {
    yield { type: "tool-start", index: 0, id: "ask", name: "durable_wait" };
    yield { type: "tool-input", index: 0, json: JSON.stringify({ kind: "question", key: "confirm", question: "继续吗", about: "只接着做剩余工作" }) };
    yield { type: "tool-start", index: 1, id: "write-after-ask", name: "write" };
    yield { type: "tool-input", index: 1, json: JSON.stringify({ path: "must-not-exist", content: "bad" }) };
    yield { type: "response-end", reason: "tool-use" };
  } });
  const { run, tasks } = await f.runtime.submit({ commandId: "batch", objective: "Wait before writing", configuration: { ...f.config, allowWrite: true, checks: ["check"] } });
  await until(f.runtime, () => f.store.getTask(tasks[0]!.taskId)?.status === "waiting");
  expect(await readFile(join(f.workspace, "must-not-exist"), "utf8").catch(() => undefined)).toBeUndefined();
  expect(f.store.operationHeaders(run.runId).some((item) => item.name === "write")).toBe(false);
});

test("a due timer wakes after owner restart without a model request while waiting", async () => {
  let calls = 0;
  const dueAt = Date.now() + 500;
  const f = await fixture({ async *stream(request) {
    if (++calls === 1) yield* call("durable_wait", { kind: "timer", key: "review", at: new Date(dueAt).toISOString(), about: "核实检查结果" });
    else { expect(JSON.stringify(request.messages)).toContain("核实检查结果"); yield* report(); }
  } });
  const { run, tasks } = await f.runtime.submit({ commandId: "timer", objective: "Review later", configuration: f.config });
  await until(f.runtime, () => f.store.getTask(tasks[0]!.taskId)?.status === "waiting");
  await f.runtime.close(); expect(calls).toBe(1);
  await Bun.sleep(Math.max(0, dueAt - Date.now() + 20));
  const runtime = new DurableRuntime(f.store, f.state, f.factory); runtimes.push(runtime); await runtime.start();
  // No manual ticks: the owner's deadline timer must dispatch the continuation.
  const end = Date.now() + 5000;
  while (f.store.getRun(run.runId)?.status !== "succeeded" && Date.now() < end) await Bun.sleep(10);
  expect(f.store.getRun(run.runId)?.status).toBe("succeeded"); expect(calls).toBe(2);
  expect(f.store.events(run.runId).filter((event) => event.type === "wait.elapsed")).toHaveLength(1);
});

test("an answer received while paused stays durable and does not resume the Run", async () => {
  let calls = 0;
  const f = await fixture({ async *stream() {
    if (++calls === 1) yield* call("durable_wait", { kind: "question", key: "pause", question: "继续吗", about: "继续剩余工作" });
    else yield* report();
  } });
  const { run, tasks } = await f.runtime.submit({ commandId: "pause", objective: "Pause waiting", configuration: f.config });
  await until(f.runtime, () => f.store.getTask(tasks[0]!.taskId)?.status === "waiting");
  f.runtime.commands.pauseRun({ commandId: "pause-now", runId: run.runId, expectedRevision: f.store.getRun(run.runId)!.revision });
  await until(f.runtime, () => f.store.getRun(run.runId)?.status === "paused");
  const question = f.runtime.waits.questions(run.runId)[0]!;
  f.runtime.waits.answer({ commandId: "answer-paused", runId: run.runId, waitId: question.waitId, expectedVersion: question.version, answer: "继续" });
  await Bun.sleep(40); expect(calls).toBe(1); expect(f.store.getRun(run.runId)?.status).toBe("paused");
  await f.runtime.resume(run.runId);
  await until(f.runtime, () => f.store.getRun(run.runId)?.status === "succeeded"); expect(calls).toBe(2);
});

test("a leaf question parks every ancestor and recovers the same tree after restart", async () => {
  const requests = [0, 0, 0];
  const f = await fixture({ async *stream(request) {
    const first = JSON.stringify(request.messages[0]);
    const level = first.includes("leaf-objective") ? 2 : first.includes("middle-objective") ? 1 : 0;
    if (requests[level]!++ === 0) {
      if (level < 2) yield* call("agent", { key: "child", prompt: level === 0 ? "middle-objective" : "leaf-objective" });
      else yield* call("durable_wait", { kind: "question", key: "leaf-question", question: "选择方案", about: "只完成叶任务" });
    } else {
      if (level < 2) expect(JSON.stringify(request.messages)).toContain("Accepted deliverable");
      yield* report();
    }
  } });
  const { run } = await f.runtime.submit({ commandId: "tree", objective: "root-objective", configuration: f.config });
  await until(f.runtime, () => f.store.tasks(run.runId).length === 3 && f.store.tasks(run.runId).every((task) => task.status === "waiting"));
  await until(f.runtime, () => f.store.activeAttempts(run.runId).length === 0);
  const ids = f.store.tasks(run.runId).map((task) => task.taskId);
  await f.runtime.close(); expect(await workspaceIsLocked(f.workspace)).toBe(false);
  const runtime = new DurableRuntime(f.store, f.state, f.factory); runtimes.push(runtime); await runtime.start();
  expect(requests).toEqual([1, 1, 1]);
  const question = runtime.waits.questions(run.runId)[0]!;
  runtime.waits.answer({ commandId: "answer-leaf", runId: run.runId, waitId: question.waitId, expectedVersion: question.version, answer: "采用方案 A" });
  await until(runtime, () => f.store.getRun(run.runId)?.status === "succeeded");
  expect(f.store.tasks(run.runId).map((task) => task.taskId)).toEqual(ids);
  expect(requests).toEqual([2, 2, 2]); expect(f.store.records("delegation", run.runId)).toHaveLength(2);
});

test("cancelled questions cannot accept late answers or wake a terminal task", async () => {
  const f = await fixture({ async *stream() { yield* call("durable_wait", { kind: "question", key: "cancel", question: "继续吗", about: "未完成" }); } });
  const { run, tasks } = await f.runtime.submit({ commandId: "cancel", objective: "Cancel waiting", configuration: f.config });
  await until(f.runtime, () => f.store.getTask(tasks[0]!.taskId)?.status === "waiting");
  const question = f.runtime.waits.questions(run.runId)[0]!;
  f.runtime.commands.cancelRun({ commandId: "cancel-now", runId: run.runId, expectedRevision: f.store.getRun(run.runId)!.revision });
  await until(f.runtime, () => f.store.getRun(run.runId)?.status === "cancelled");
  expect(() => f.runtime.waits.answer({ commandId: "late", runId: run.runId, waitId: question.waitId, expectedVersion: question.version, answer: "继续" })).toThrow();
  expect(f.runtime.waits.questions(run.runId)).toHaveLength(0);
});

test("an answer racing with parking is not lost and cannot grant write authority", async () => {
  let calls = 0;
  const f = await fixture({ async *stream(request) {
    if (!calls++) yield* call("durable_wait", { kind: "question", key: "race", question: "确认方案", about: "继续剩余工作" });
    else {
      expect(JSON.stringify(request.messages)).toContain("确认");
      expect(request.tools.some((tool) => tool.name === "write")).toBe(false); yield* report();
    }
  } });
  const unlisten = f.store.onChange(() => {
    const run = f.store.runs()[0], question = run && f.runtime.waits.questions(run.runId)[0];
    if (question) {
      unlisten();
      f.runtime.waits.answer({ commandId: "early-answer", runId: run!.runId, waitId: question.waitId, expectedVersion: question.version, answer: "确认；答案不能提高写入权限" });
    }
  });
  const { run } = await f.runtime.submit({ commandId: "race", objective: "Race answer", configuration: f.config });
  await until(f.runtime, () => f.store.getRun(run.runId)?.status === "succeeded"); expect(calls).toBe(2);
  expect(f.store.events(run.runId).filter((event) => event.type === "wait.resumed")).toHaveLength(1);
});

test("parallel readers retain the physical workspace lease until the final reader exits", async () => {
  const both = Promise.withResolvers<void>(), releaseSlow = Promise.withResolvers<void>(); let readers = 0;
  const f = await fixture({ async *stream(request, signal) {
    const first = JSON.stringify(request.messages[0]);
    if (first.includes("lease-fast") || first.includes("lease-slow")) {
      if (++readers === 2) both.resolve();
      await both.promise;
      if (first.includes("lease-slow")) {
        await Promise.race([releaseSlow.promise, new Promise<void>((done) => signal!.addEventListener("abort", () => done(), { once: true }))]);
        signal!.throwIfAborted();
      }
      yield* report();
    } else if (!request.messages.some((message) => message.content.some((block) => block.type === "tool-result"))) {
      yield* call("agent", { tasks: [{ key: "fast", prompt: "lease-fast" }, { key: "slow", prompt: "lease-slow" }] });
    } else yield* report();
  } });
  const { run } = await f.runtime.submit({ commandId: "leases", objective: "Share reader leases", configuration: f.config });
  try {
    await until(f.runtime, () => f.store.tasks(run.runId).some((task) => task.objective === "lease-fast" && task.status === "succeeded"));
    expect(await workspaceIsLocked(f.workspace)).toBe(true);
    await expect(acquireWorkspace(f.workspace)).rejects.toThrow("already being held");
  } finally { releaseSlow.resolve(); }
  await until(f.runtime, () => f.store.getRun(run.runId)?.status === "succeeded");
});

test("a read-only child of a coding parent acquires its own lease before the parent parks", async () => {
  const f = await fixture({ async *stream(request) {
    if (JSON.stringify(request.messages[0]).includes("coding-child")) {
      expect(await workspaceIsLocked(f.workspace)).toBe(true);
      yield* call("durable_wait", { kind: "question", key: "child-question", question: "采用哪个方案", about: "继续调查" });
    } else yield* call("agent", { key: "child", prompt: "coding-child" });
  } });
  const { run } = await f.runtime.submit({ commandId: "writer-parent", objective: "Coding parent", configuration: { ...f.config, allowWrite: true, checks: ["check"] } });
  await until(f.runtime, () => f.store.tasks(run.runId).length === 2 && f.store.tasks(run.runId).every((task) => task.status === "waiting"));
  await until(f.runtime, () => f.store.activeAttempts(run.runId).length === 0);
  await f.runtime.close(); expect(await workspaceIsLocked(f.workspace)).toBe(false);
});

test("SIGKILL after saving a question but before its tool receipt parks on restart without replaying business", async () => {
  let calls = 0;
  const f = await fixture({ async *stream(request) { calls++; expect(JSON.stringify(request.messages)).toContain("继续原任务"); yield* report(); } });
  await f.runtime.close(); f.store.close();
  const source = `import {DurableRuntime} from ${JSON.stringify(join(import.meta.dir, "../../src/services/runtime/engine.ts"))};
import {RuntimeStore} from ${JSON.stringify(join(import.meta.dir, "../../src/services/runtime/store.ts"))};
const store=new RuntimeStore(${JSON.stringify(f.db)});
const runtime=new DurableRuntime(store,${JSON.stringify(f.state)},async()=>({model:"fixture",tools:[],maxOutputTokens:100,route:{provider:"fixture",model:"fixture"},authorize:async()=>({behavior:"allow"}),transport:{async *stream(){
 yield {type:"tool-start",index:0,id:"ask",name:"durable_wait"};
 yield {type:"tool-input",index:0,json:JSON.stringify({kind:"question",key:"crash",question:"继续吗",about:"继续原任务"})};
 yield {type:"response-end",reason:"tool-use"};
}}}));
await runtime.start();
store.onChange(()=>{const run=store.runs()[0];if(run&&store.records("wait",run.runId).length)process.kill(process.pid,"SIGKILL")});
await runtime.submit({commandId:"kill-question",objective:"Crash question",configuration:${JSON.stringify(f.config)}});
setInterval(()=>{},1000);`;
  const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(10000) });
  await child.exited; expect(child.signalCode).toBe("SIGKILL"); expect(await new Response(child.stderr).text()).toBe("");
  const store = new RuntimeStore(f.db); stores.push(store);
  const run = store.runs()[0]!, task = store.tasks(run.runId)[0]!;
  const runtime = new DurableRuntime(store, f.state, f.factory); runtimes.push(runtime);
  const end = Date.now() + 8000;
  for (;;) {
    try { await runtime.start(); break; }
    catch (error) { if (!String(error).includes("already being held") || Date.now() > end) throw error; await Bun.sleep(100); }
  }
  await until(runtime, () => store.getTask(task.taskId)?.status === "waiting"); expect(calls).toBe(0);
  const question = runtime.waits.questions(run.runId)[0]!;
  runtime.waits.answer({ commandId: "answer-after-kill", runId: run.runId, waitId: question.waitId, expectedVersion: question.version, answer: "继续原任务" });
  await until(runtime, () => store.getRun(run.runId)?.status === "succeeded");
  expect(calls).toBe(1); expect(store.records("wait", run.runId)).toHaveLength(1);
  expect(store.operationHeaders(run.runId).every((operation) => operation.state === "settled")).toBe(true);
}, 20000);
