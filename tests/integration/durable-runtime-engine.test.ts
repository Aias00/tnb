// Legacy v1 policy fixtures verify compatibility; v2 routing and delegation have separate contract tests.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableRuntime, type RuntimeConfiguration, type RuntimeWorkerFactory } from "../../src/services/runtime/engine";
import { RuntimeStore } from "../../src/services/runtime/store";
import { createReadTool, createWriteTool } from "../../src/tools/builtins";
import { createFileStateCacheWithSizeLimit } from "../../src/utils/file-state-cache";
import type { ModelTransport } from "../../src/providers/types";

const roots: string[] = []; const runtimes: DurableRuntime[] = []; const stores: RuntimeStore[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(transport: ModelTransport, check?: (command: string) => Promise<string>, holdValidation = false) {
  const root = await mkdtemp(join(tmpdir(), "tnb-runtime-engine-")); roots.push(root);
  const workspace = join(root, "work"); await mkdir(workspace);
  const state = join(root, "control", "runtime"); const store = new RuntimeStore(join(state, "state.sqlite")); stores.push(store);
  const validation = Promise.withResolvers<void>();
  if (!holdValidation) validation.resolve();
  const factory: RuntimeWorkerFactory = async ({ task, signal }) => {
    // A real async boundary keeps interruption tests independent of scheduler speed.
    if (task.status === "validating") {
      await Promise.race([validation.promise, new Promise<void>((resolve) => {
        if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
      })]);
      signal.throwIfAborted();
    }
    const cache = createFileStateCacheWithSizeLimit(100);
    return { transport, model: "fixture", tools: [createReadTool(workspace, undefined, undefined, cache), createWriteTool(workspace, undefined, cache)],
      route: { provider: "fixture", model: "fixture", pricing: { input: 1, output: 1 } }, maxOutputTokens: 100,
      authorize: async () => ({ behavior: "allow" }), check: check ? (command) => check(command) : undefined };
  };
  const runtime = new DurableRuntime(store, state, factory); runtimes.push(runtime); await runtime.start();
  const config: RuntimeConfiguration = { workspace, allowedWorkspaces: [workspace], allowWrite: false, allowShell: false, checks: [],
    maxTurns: 10, maxRetries: 1, strategyVersion: 1, compactThreshold: 10000, maxCostUsd: 1 };
  return { runtime, store, config, workspace, state, factory, releaseValidation: () => validation.resolve() };
}
async function settled(runtime: DurableRuntime, runId: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await runtime.tick(); const run = runtime.store.getRun(runId)!;
    if (["succeeded", "failed", "paused", "cancelled"].includes(run.status)) return run;
    await Bun.sleep(10);
  }
  throw new Error(`Run did not settle: ${JSON.stringify(runtime.store.tasks(runId))}; ${runtime.lastError}`);
}
const report: ModelTransport = { async *stream() { yield { type: "text", index: 0, text: "Verified report" }; yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }; yield { type: "response-end", reason: "end-turn" }; } };

test("adding budget to a paused Run preserves its binding and lets the original task continue", async () => {
  const f = await fixture(report);
  const { run } = await f.runtime.submit({ commandId: "small-budget", objective: "Resume after budget increase", configuration: { ...f.config, maxCostUsd: 0.000000001 } });
  expect((await settled(f.runtime, run.runId)).status).toBe("paused");
  const binding = f.store.record("binding", f.store.tasks(run.runId)[0]!.taskId)!.value;
  const paused = f.store.getRun(run.runId)!; expect(paused.pauseReason).toBe("budget");
  f.runtime.commands.updateLimits({ commandId: "increase", runId: run.runId, expectedRevision: paused.revision, maxCostUsd: 2 });
  expect(f.runtime.configuration(run.runId).maxCostUsd).toBe(2);
  await f.runtime.resume(run.runId); expect((await settled(f.runtime, run.runId)).status).toBe("succeeded");
  expect(f.store.record("binding", f.store.tasks(run.runId)[0]!.taskId)!.value).toBe(binding);
});

test("real Agent loop delivers and accepts a versioned report through durable scheduling", async () => {
  const f = await fixture(report); const { run, tasks } = await f.runtime.submit({ commandId: "submit", objective: "Inspect code", configuration: f.config });
  expect((await settled(f.runtime, run.runId)).status).toBe("succeeded");
  const task = f.store.getTask(tasks[0]!.taskId)!;
  expect(task.resultRef).toBeDefined();
  expect(await f.runtime.artifacts.get(task.resultRef!)).toMatchObject({ report: "Verified report", acceptance: "report-delivered" });
  expect(f.runtime.budget.totals(run.runId).reported).toBeGreaterThan(0);
});

test("coding changes are accepted only after a real tool effect and explicit verification", async () => {
  let request = 0; let checks = 0;
  const transport: ModelTransport = { async *stream(input) {
    const workspace = /^Working directory: (.+)$/m.exec(input.systemPrompt ?? "")?.[1];
    expect(workspace).toBe(await import("node:fs/promises").then((fs) => fs.realpath(f.workspace)));
    if (++request === 1) {
      yield { type: "tool-start", index: 0, id: "write-one", name: "write" };
      yield { type: "tool-input", index: 0, json: JSON.stringify({ path: join(workspace!, "result.ts"), content: "export const value = 42;\n" }) };
      yield { type: "response-end", reason: "tool-use" };
    } else { yield { type: "text", index: 0, text: "Implemented value" }; yield { type: "response-end", reason: "end-turn" }; }
  } };
  const f = await fixture(transport, async () => { checks++; expect(await readFile(join(f.workspace, "result.ts"), "utf8")).toContain("42"); return "passed"; });
  const { run, tasks } = await f.runtime.submit({ commandId: "submit", objective: "Implement value", configuration: { ...f.config, allowWrite: true, checks: ["fixture verification"] } });
  expect((await settled(f.runtime, run.runId)).status).toBe("succeeded"); expect(checks).toBe(1);
  const evidence = await f.runtime.artifacts.get<{ checks: unknown[] }>(f.store.getTask(tasks[0]!.taskId)!.resultRef!);
  expect(evidence.checks).toHaveLength(1);
});

test("single mode exposes no delegate tool; auto mode durably reuses a bounded child investigation", async () => {
  let rootsSeen = 0;
  const transport: ModelTransport = { async *stream(request) {
    const isChild = request.messages.some((message) => message.content.some((block) => block.type === "text" && block.text.includes("child investigation")));
    if (!isChild && rootsSeen++ === 0) {
      expect(request.tools.some((tool) => tool.name === "agent")).toBe(true);
      yield { type: "tool-start", index: 0, id: "delegate", name: "agent" };
      yield { type: "tool-input", index: 0, json: JSON.stringify({ key: "inspect", prompt: "child investigation" }) };
      yield { type: "response-end", reason: "tool-use" };
    } else { yield { type: "text", index: 0, text: isChild ? "Child evidence" : "Combined evidence" }; yield { type: "response-end", reason: "end-turn" }; }
  } };
  const f = await fixture(transport);
  const { run } = await f.runtime.submit({ commandId: "submit", objective: "Investigate independently", configuration: f.config, mode: "auto" });
  expect((await settled(f.runtime, run.runId)).status).toBe("succeeded");
  expect(f.store.tasks(run.runId)).toHaveLength(2);
  expect(f.store.records("delegation", run.runId)).toHaveLength(1);
  let exposed = false;
  const single = await fixture({ async *stream(request) { exposed = request.tools.some((tool) => tool.name === "agent"); yield { type: "text", index: 0, text: "single" }; yield { type: "response-end", reason: "end-turn" }; } });
  const created = await single.runtime.submit({ commandId: "single", objective: "simple", configuration: single.config, mode: "single" });
  expect((await settled(single.runtime, created.run.runId)).status).toBe("succeeded"); expect(exposed).toBe(false);
});

async function until(condition: () => boolean, runtime: DurableRuntime, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!condition()) { if (Date.now() > end) throw new Error(`Condition timed out: ${runtime.lastError}`); await runtime.tick(); await Bun.sleep(10); }
}
function restart(f: Awaited<ReturnType<typeof fixture>>, factory = f.factory) {
  const runtime = new DurableRuntime(f.store, f.state, factory); runtimes.push(runtime); return runtime;
}

test("restart accepts an already durable terminal report without another model request", async () => {
  const f = await fixture(report, undefined, true);
  const submitted = await f.runtime.submit({ commandId: "saved-report", objective: "Saved candidate", configuration: f.config });
  // Stop before the validation wake; the durable terminal transcript must be sufficient on restart.
  await until(() => f.store.getTask(submitted.tasks[0]!.taskId)?.status === "validating", f.runtime);
  await f.runtime.close();
  f.releaseValidation();
  f.store.command("interrupt-before-candidate", {}, Date.now(), (tx) => {
    const task = tx.getTask(submitted.tasks[0]!.taskId)!;
    tx.saveTask({ ...task, status: "reconciling", revision: task.revision + 1, candidateRef: undefined }, task.revision); return true;
  });
  let calls = 0;
  const runtime = restart(f, async (context) => ({ ...await f.factory(context), transport: { async *stream() { calls++; throw new Error("must not call model"); } } }));
  await runtime.start(); expect((await settled(runtime, submitted.run.runId)).status).toBe("succeeded"); expect(calls).toBe(0);
});

test("failed verification feeds the failure back to the model and retries a bounded attempt", async () => {
  let calls = 0; let checks = 0;
  const f = await fixture({ async *stream(request) {
    if (calls++) expect(JSON.stringify(request.messages)).toContain("fixture failed");
    yield { type: "text", index: 0, text: "candidate" }; yield { type: "response-end", reason: "end-turn" };
  } }, async () => { if (!checks++) throw new Error("fixture failed"); return "passed"; });
  const { run } = await f.runtime.submit({ commandId: "retry-check", objective: "Repair failure", configuration: { ...f.config, checks: ["check"] } });
  expect((await settled(f.runtime, run.runId)).status).toBe("succeeded"); expect(checks).toBe(2); expect(calls).toBe(2);
});

test("a queued validating task cancels cleanly without accepting its candidate", async () => {
  const f = await fixture(report, undefined, true);
  const { run, tasks } = await f.runtime.submit({ commandId: "cancel-validation", objective: "cancel candidate", configuration: f.config });
  await until(() => f.store.getTask(tasks[0]!.taskId)?.status === "validating", f.runtime);
  f.runtime.commands.cancelRun({ commandId: "cancel", runId: run.runId, expectedRevision: f.store.getRun(run.runId)!.revision });
  expect((await settled(f.runtime, run.runId)).status).toBe("cancelled");
  expect(f.store.getTask(tasks[0]!.taskId)?.status).toBe("cancelled"); expect(f.runtime.lastError).toBeUndefined();
});

test("stale report inputs fail validation and require a fresh model inspection", async () => {
  let calls = 0;
  const f = await fixture({ async *stream() { calls++; yield { type: "text", index: 0, text: "current report" }; yield { type: "response-end", reason: "end-turn" }; } }, undefined, true);
  const { run, tasks } = await f.runtime.submit({ commandId: "stale-input", objective: "inspect version", configuration: f.config });
  await until(() => f.store.getTask(tasks[0]!.taskId)?.status === "validating", f.runtime);
  await writeFile(join(f.workspace, "changed.ts"), "new input");
  f.releaseValidation();
  expect((await settled(f.runtime, run.runId)).status).toBe("succeeded"); expect(calls).toBe(2);
});

test("restart recovers root, intermediate and leaf identities with accepted child results", async () => {
  let interrupted = false; let leafStarted = false;
  const transport: ModelTransport = { async *stream(request, signal) {
    const serialized = JSON.stringify(request.messages[0]);
    const level = serialized.includes("leaf objective") ? 2 : serialized.includes("middle objective") ? 1 : 0;
    const hasResult = request.messages.some((m) => m.content.some((b) => b.type === "tool-result" && !b.isError));
    if (level < 2 && !hasResult) {
      yield { type: "tool-start", index: 0, id: `delegate-${level}`, name: "agent" };
      yield { type: "tool-input", index: 0, json: JSON.stringify({ key: "stable-child", prompt: level === 0 ? "middle objective" : "leaf objective" }) };
      yield { type: "response-end", reason: "tool-use" }; return;
    }
    if (level === 2 && !interrupted) {
      leafStarted = true;
      await new Promise<void>((done) => signal!.addEventListener("abort", () => done(), { once: true })); signal!.throwIfAborted();
    }
    yield { type: "text", index: 0, text: `result level ${level}` }; yield { type: "response-end", reason: "end-turn" };
  } };
  const f = await fixture(transport);
  const { run } = await f.runtime.submit({ commandId: "nested", objective: "root objective", configuration: f.config, mode: "auto" });
  await until(() => leafStarted, f.runtime); const identities = f.store.tasks(run.runId).map((t) => t.taskId);
  expect(identities).toHaveLength(3);
  await f.runtime.close(); interrupted = true;
  const runtime = restart(f); await runtime.start();
  const result = await settled(runtime, run.runId);
  expect({ status: result.status, errors: f.store.tasks(run.runId).map((t) => t.error).filter(Boolean) }).toEqual({ status: "succeeded", errors: [] });
  expect(f.store.tasks(run.runId).map((t) => t.taskId)).toEqual(identities);
  expect(f.store.records("delegation", run.runId)).toHaveLength(2);
  expect(f.store.activeAttempts(run.runId)).toHaveLength(0);
  expect(f.store.tasks(run.runId).every((t) => t.status === "succeeded")).toBe(true);
}, 15000);

test("cancelling a waiting root drains every descendant and never accepts a late result", async () => {
  let waiting = false;
  const f = await fixture({ async *stream(request, signal) {
    if (!JSON.stringify(request.messages).includes("blocked child")) {
      yield { type: "tool-start", index: 0, id: "delegate", name: "agent" };
      yield { type: "tool-input", index: 0, json: JSON.stringify({ key: "wait", prompt: "blocked child" }) };
      yield { type: "response-end", reason: "tool-use" };
    } else {
      waiting = true; await new Promise<void>((done) => signal!.addEventListener("abort", () => done(), { once: true }));
      yield { type: "text", index: 0, text: "late result" }; yield { type: "response-end", reason: "end-turn" };
    }
  } });
  const { run } = await f.runtime.submit({ commandId: "cancel-tree", objective: "parent", configuration: f.config, mode: "auto" });
  await until(() => waiting, f.runtime);
  f.runtime.commands.cancelRun({ commandId: "cancel-tree-now", runId: run.runId, expectedRevision: f.store.getRun(run.runId)!.revision });
  expect((await settled(f.runtime, run.runId)).status).toBe("cancelled");
  expect(f.store.tasks(run.runId).every((t) => t.status === "cancelled")).toBe(true);
  expect(f.store.activeAttempts(run.runId)).toHaveLength(0);
});

test("actual SIGKILL at a leaf recovers all three levels without duplicating child work", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-runtime-tree-kill-")); roots.push(root);
  const workspace = join(root, "work"); await mkdir(workspace);
  const state = join(root, "control", "runtime");
  const config: RuntimeConfiguration = { workspace, allowedWorkspaces: [workspace], allowWrite: false, allowShell: false, checks: [], maxTurns: 10, maxRetries: 1, strategyVersion: 1, compactThreshold: 10000 };
  const source = `import { DurableRuntime } from ${JSON.stringify(join(import.meta.dir, "../../src/services/runtime/engine.ts"))};
import { RuntimeStore } from ${JSON.stringify(join(import.meta.dir, "../../src/services/runtime/store.ts"))};
const store = new RuntimeStore(${JSON.stringify(join(state, "state.sqlite"))});
const runtime = new DurableRuntime(store, ${JSON.stringify(state)}, async ({task}) => ({
 model:"fixture", route:{provider:"fixture",model:"fixture"},maxOutputTokens:100,tools:[],authorize:async()=>({behavior:"allow"}),
 transport:{async *stream(){
  if(task.objective === "leaf") process.kill(process.pid,"SIGKILL");
  yield {type:"tool-start",index:0,id:"child",name:"agent"};
  yield {type:"tool-input",index:0,json:JSON.stringify({key:"child",prompt:task.objective === "root" ? "middle" : "leaf"})};
  yield {type:"response-end",reason:"tool-use"};
 }}
}));
await runtime.start(); await runtime.submit({commandId:"kill-tree",objective:"root",configuration:${JSON.stringify(config)},mode:"auto"});
setInterval(()=>{},1000);`;
  const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(10000) });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).not.toBe(0); expect(child.signalCode).toBe("SIGKILL"); expect(error).toBe("");
  const store = new RuntimeStore(join(state, "state.sqlite")); stores.push(store);
  const run = store.runs()[0]!; const identities = store.tasks(run.runId).map((task) => task.taskId);
  expect(identities).toHaveLength(3);
  const factory: RuntimeWorkerFactory = async ({ task }) => ({
    model: "fixture", route: { provider: "fixture", model: "fixture" }, maxOutputTokens: 100, tools: [], authorize: async () => ({ behavior: "allow" }),
    transport: { async *stream(request) {
      if (task.objective !== "leaf") expect(JSON.stringify(request.messages)).toContain("result level");
      yield { type: "text", index: 0, text: `result level ${task.objective}` }; yield { type: "response-end", reason: "end-turn" };
    } },
  });
  // A new owner must respect the former owner's lock expiry, then reclaim the original identities.
  const runtime = new DurableRuntime(store, state, factory); runtimes.push(runtime);
  const end = Date.now() + 10000;
  for (;;) { try { await runtime.start(); break; } catch (error) { if (!String(error).includes("already being held") || Date.now() > end) throw error; await Bun.sleep(100); } }
  expect((await settled(runtime, run.runId)).status).toBe("succeeded");
  expect(store.tasks(run.runId).map((task) => task.taskId)).toEqual(identities);
  expect(store.records("delegation", run.runId)).toHaveLength(2);
  expect(store.activeAttempts(run.runId)).toHaveLength(0);
}, 25000);

test("auto mode admits independent read-only branches in parallel and records its decision", async () => {
  let branchesRunning = 0; let peak = 0; let release!: () => void;
  const both = new Promise<void>((done) => { release = done; });
  const f = await fixture({ async *stream(request) {
    const prompt = JSON.stringify(request.messages[0]);
    if (prompt.includes("branch-")) {
      peak = Math.max(peak, ++branchesRunning); if (branchesRunning === 2) release();
      await both; branchesRunning--;
      yield { type: "text", index: 0, text: "independent evidence" }; yield { type: "response-end", reason: "end-turn" }; return;
    }
    const hasResults = request.messages.some((m) => m.content.some((b) => b.type === "tool-result"));
    if (!hasResults) {
      yield { type: "tool-start", index: 0, id: "parallel", name: "agent" };
      yield { type: "tool-input", index: 0, json: JSON.stringify({ tasks: [
        { key: "a", prompt: "branch-a", reason: "independent protocol investigation" },
        { key: "b", prompt: "branch-b", reason: "independent persistence investigation" },
      ] }) }; yield { type: "response-end", reason: "tool-use" };
    } else { yield { type: "text", index: 0, text: "combined evidence" }; yield { type: "response-end", reason: "end-turn" }; }
  } });
  const { run } = await f.runtime.submit({ commandId: "parallel", objective: "compare independent modules", configuration: f.config });
  expect((await settled(f.runtime, run.runId)).status).toBe("succeeded"); expect(peak).toBe(2);
  const decisions = f.store.events(run.runId, 0, 1000).filter((event) => event.type === "task.delegated");
  expect(decisions).toHaveLength(2);
  expect(decisions[0]!.data).toMatchObject({ mode: "auto", authority: "read-only", batchSize: 2, planRevision: 1 });
  expect(f.store.record<number>("plan", run.runId)?.value).toBe(2);
});

test("unknown writes remain blocked across restart and require confirmed reconciliation before resuming", async () => {
  let requests = 0; let writes = 0;
  const f = await fixture({ async *stream() {
    if (!requests++) {
      yield { type: "tool-start", index: 0, id: "unsafe", name: "write" };
      yield { type: "tool-input", index: 0, json: JSON.stringify({ path: "result.txt", content: "written once" }) };
      yield { type: "response-end", reason: "tool-use" };
    } else { yield { type: "text", index: 0, text: "confirmed delivery" }; yield { type: "response-end", reason: "end-turn" }; }
  } }, async () => "verified");
  await f.runtime.close();
  const broken = restart(f, async (context) => {
    const resources = await f.factory(context); const write = resources.tools.find((tool) => tool.name === "write")!; const execute = write.execute;
    write.bindExecution = undefined;
    write.execute = async (...args) => { writes++; await execute(...args); throw new Error("lost acknowledgement after effect"); }; return resources;
  }); await broken.start();
  const { run, tasks } = await broken.submit({ commandId: "unknown", objective: "write once", configuration: { ...f.config, allowWrite: true, checks: ["verify"] } });
  expect((await settled(broken, run.runId)).status).toBe("paused"); expect(writes).toBe(1);
  await broken.close();
  const runtime = restart(f); await runtime.start();
  expect(f.store.getRun(run.runId)?.status).toBe("paused"); expect(requests).toBe(1);
  const operation = f.store.operationHeaders(run.runId)[0]!; expect(operation.effectOutcome).toBe("unknown");
  await runtime.reconcile(tasks[0]!.taskId, operation.id, "Confirmed result.txt contains written once");
  await runtime.resume(run.runId);
  const recovered = await settled(runtime, run.runId);
  expect({ status: recovered.status, errors: f.store.tasks(run.runId).map((task) => task.error).filter(Boolean) }).toEqual({ status: "succeeded", errors: [] }); expect(writes).toBe(1);
  expect(await readFile(join(f.workspace, "result.txt"), "utf8")).toBe("written once");
});

test("cross-workspace delegation requires explicit authorization and shares the originating Run", async () => {
  const f = await fixture(report); const other = join(f.workspace, "..", "other"); await mkdir(other);
  let calls = 0;
  await f.runtime.close();
  const runtime = restart(f, async (context) => ({ ...await f.factory(context), transport: { async *stream(request) {
    if (!context.task.parentTaskId && !calls++) {
      yield { type: "tool-start", index: 0, id: "cross-workspace", name: "agent" };
      yield { type: "tool-input", index: 0, json: JSON.stringify({ key: "cross", prompt: "Inspect the authorized other project", workspace: other, reason: "independent project context" }) };
      yield { type: "response-end", reason: "tool-use" };
    } else {
      if (context.task.parentTaskId) expect(context.configuration.workspace).toBe(await import("node:fs/promises").then((fs) => fs.realpath(other)));
      expect(request.systemPrompt).toContain(`Working directory: ${context.configuration.workspace}\n`);
      yield { type: "text", index: 0, text: "cross-workspace evidence" }; yield { type: "response-end", reason: "end-turn" };
    }
  } } })); await runtime.start();
  const { run } = await runtime.submit({ commandId: "cross", objective: "Inspect two projects", configuration: { ...f.config, allowedWorkspaces: [f.workspace, other] } });
  expect((await settled(runtime, run.runId)).status).toBe("succeeded"); expect(f.store.tasks(run.runId)).toHaveLength(2);
  expect(f.store.records("model-request", run.runId)).toHaveLength(3);
});

test("foreground workspace ownership is a resource wait and consumes neither attempts nor retry budget", async () => {
  const f = await fixture(report); const { acquireWorkspace } = await import("../../src/services/runtime/workspace");
  const release = await acquireWorkspace(f.workspace);
  const { run, tasks } = await f.runtime.submit({ commandId: "foreground-handoff", objective: "Continue after chat", configuration: { ...f.config, maxRetries: 0 } });
  try {
    await f.runtime.tick(); await Bun.sleep(1100); await f.runtime.tick();
    expect(f.store.getRun(run.runId)?.status).toBe("active"); expect(f.store.getTask(tasks[0]!.taskId)?.status).toBe("ready");
    expect(f.store.activeAttempts(run.runId)).toHaveLength(0); expect(f.store.records("model-request", run.runId)).toHaveLength(0);
    expect(f.store.record("execution-retries", tasks[0]!.taskId)).toBeUndefined();
    expect(f.store.events(run.runId).filter((event) => event.type === "task.resource-wait")).toHaveLength(1);
  } finally { await release(); }
  expect((await settled(f.runtime, run.runId)).status).toBe("succeeded");
});

test("an unavailable workspace pauses its Run without stopping other service dispatch", async () => {
  const f = await fixture(report);
  const { run } = await f.runtime.submit({ commandId: "missing-workspace", objective: "Handle unavailable workspace", configuration: f.config });
  await rm(f.workspace, { recursive: true, force: true });
  expect((await settled(f.runtime, run.runId)).status).toBe("paused"); expect(f.runtime.lastError).toBeUndefined();
});
