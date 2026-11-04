import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DurableRuntime, type RuntimeConfiguration, type RuntimeWorkerFactory } from "../../src/services/runtime/engine";
import { RuntimeStore } from "../../src/services/runtime/store";
import { defineTool } from "../../src/core/tool";
import type { ModelTransport } from "../../src/providers/types";
import type { TaskInput } from "../../src/services/runtime/routing";
import { serveDurableRuntime, runtimeRequest } from "../../src/services/runtime/server";
import { DurableQuestionInbox, durableUserQuestion } from "../../src/services/runtime/attention";

const roots: string[] = [], stores: RuntimeStore[] = [], runtimes: DurableRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(transport: ModelTransport, check?: () => Promise<string>) {
  const root = await mkdtemp(join(tmpdir(), "tnb-route-engine-")); roots.push(root);
  const workspace = join(root, "work"); await mkdir(workspace); const canonical = await realpath(workspace);
  const state = join(root, "control", "runtime"), database = join(state, "state.sqlite");
  const store = new RuntimeStore(database); stores.push(store); let effects = 0;
  const factory: RuntimeWorkerFactory = async () => ({ transport, model: "fixture", tools: [defineTool({ name: "probe", description: "Read fixture", access: "read", isReadOnly: () => true,
    inputSchema: {}, validate: (input) => input, execute: async () => { effects++; return "evidence checked once"; } })], authorize: async () => ({ behavior: "allow" }),
    route: { provider: "fixture", model: "fixture" }, maxOutputTokens: 512, check });
  const runtime = new DurableRuntime(store, state, factory); runtimes.push(runtime); await runtime.start();
  const config: RuntimeConfiguration = { workspace, allowedWorkspaces: [workspace], allowWrite: false, allowShell: false, checks: [], maxTurns: 12, maxRetries: 0, compactThreshold: 10000 };
  const follow = (runId: string, id: string, text: string) => runtime.router.followup({ commandId: id, runId, source: { inputId: id, rawText: text, workspace: canonical, source: "api" } });
  return { root, workspace, canonical, state, database, store, factory, runtime, config, follow, effects: () => effects };
}
async function until(runtime: DurableRuntime, check: () => boolean) { const end = Date.now() + 6000; while (!check()) { if (Date.now() > end) throw new Error(`Timeout: ${runtime.lastError}; ${JSON.stringify(runtime.store.runs())}`); await runtime.tick(); await Bun.sleep(5); } }
function* report(text = "Verified report") { yield { type: "text" as const, index: 0, text }; yield { type: "response-end" as const, reason: "end-turn" as const }; }
function* call(name: string, input: unknown, id = name) { yield { type: "tool-start" as const, index: 0, id, name }; yield { type: "tool-input" as const, index: 0, json: JSON.stringify(input) }; yield { type: "response-end" as const, reason: "tool-use" as const }; }

test("followup during a physical request preserves its scope and delivers once after the complete tool round", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let requests = 0;
  const f = await fixture({ async *stream(input) {
    if (++requests === 1) { entered.resolve(); await release.promise; expect(JSON.stringify(input.messages)).not.toContain("NEW-REQUIREMENT"); yield* call("probe", {}); }
    else { expect(JSON.stringify(input.messages).match(/User follow-up input incoming/g)).toHaveLength(1); expect(input.systemPrompt).toContain("NEW-REQUIREMENT"); yield* report("NEW-REQUIREMENT handled"); }
  } });
  const { run, tasks } = await f.runtime.submit({ commandId: "create", objective: "Inspect evidence", configuration: f.config, mode: "single" });
  await entered.promise;
  f.follow(run.runId, "incoming", "NEW-REQUIREMENT");
  expect(f.store.records<TaskInput>("task-input", run.runId)[0]!.value.state).toBe("pending"); release.resolve();
  await until(f.runtime, () => ["succeeded", "paused", "failed"].includes(f.store.getRun(run.runId)!.status));
  expect(f.store.getRun(run.runId)?.status).toBe("succeeded"); expect(f.effects()).toBe(1);
  expect(f.store.events(run.runId).filter((event) => event.type === "input.delivered")).toHaveLength(1);
  expect(f.store.getTask(tasks[0]!.taskId)?.inputRevision).toBe(1);
});

test("followup racing a validation check invalidates the old candidate without spending retry allowance", async () => {
  const validating = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let checks = 0; let requests = 0;
  const f = await fixture({ async *stream(input) { requests++; yield* report(JSON.stringify(input.messages).includes("REVISED") ? "Revised deliverable" : "Old deliverable"); } }, async () => {
    if (++checks === 1) { validating.resolve(); await release.promise; } return "passed";
  });
  const { run, tasks } = await f.runtime.submit({ commandId: "create", objective: "Deliver", configuration: { ...f.config, allowWrite: true, checks: ["verify"] }, mode: "single" });
  await validating.promise; f.follow(run.runId, "revision", "REVISED requirements"); release.resolve();
  await until(f.runtime, () => ["succeeded", "paused", "failed"].includes(f.store.getRun(run.runId)!.status));
  expect(f.store.getRun(run.runId)?.status).toBe("succeeded"); expect(checks).toBe(2); expect(requests).toBe(2);
  expect(f.store.record("retries", tasks[0]!.taskId)).toBeUndefined();
  expect(f.store.events(run.runId).some((event) => event.type === "candidate.invalidated")).toBe(true);
});

test("multi must record an assessment but can validly finish with a single Agent", async () => {
  let requests = 0;
  const f = await fixture({ async *stream() {
    if (++requests === 2) yield* call("assess_delegation", { choice: "direct", reason: "One bounded question with no independent branch", evidenceRefs: ["input"] });
    else yield* report();
  } });
  const { run } = await f.runtime.submit({ commandId: "create", objective: "Small lookup", configuration: f.config, mode: "multi" });
  await until(f.runtime, () => ["succeeded", "paused", "failed"].includes(f.store.getRun(run.runId)!.status));
  expect(f.store.getRun(run.runId)?.status).toBe("succeeded"); expect(f.store.tasks(run.runId)).toHaveLength(1);
  expect(f.store.events(run.runId).some((event) => event.type === "strategy.assessed" && (event.data as { choice: string }).choice === "direct")).toBe(true);
});

test("multi cannot silently skip its bounded assessment and run indefinitely", async () => {
  let requests = 0; const f = await fixture({ async *stream() { requests++; yield* report(); } });
  const { run } = await f.runtime.submit({ commandId: "create", objective: "Assess first", configuration: f.config, mode: "multi" });
  await until(f.runtime, () => f.store.getRun(run.runId)?.status === "paused");
  expect(requests).toBe(4); expect(f.store.tasks(run.runId)[0]!.error).toContain("four model turns");
});

test("strict proposals, evidence-backed child reports and explicit parent review complete through durable delegation", async () => {
  let rootRequests = 0;
  const f = await fixture({ async *stream(input) {
    if (input.systemPrompt?.includes('"contract":{')) { yield* call("complete_investigation", { summary: "Bounded investigation", evidenceRefs: ["input"], uncertainties: ["No code was inspected"] }); return; }
    if (++rootRequests === 1) yield* call("agent", { key: "investigate", prompt: "Independent question from original input", reason: "Independent report with isolated context",
      scope: ["."], evidenceRefs: ["input"], deliverable: "Evidence report", acceptance: "Disclose evidence and gaps", required: true, maxTurns: 5, maxRequests: 3 });
    else if (rootRequests === 2) {
      const child = f.store.runs().flatMap((run) => f.store.tasks(run.runId)).find((task) => task.parentTaskId)!;
      yield* call("review_child_result", { taskId: child.taskId, resultRef: child.resultRef, outcome: "accept", reason: "Checked the report and retained its declared uncertainty", evidenceRefs: ["input"] });
    } else yield* report("Parent integrated report and disclosed uncertainty");
  } });
  const { run } = await f.runtime.submit({ commandId: "create", objective: "Investigate independent topic", configuration: f.config });
  await until(f.runtime, () => ["succeeded", "paused", "failed"].includes(f.store.getRun(run.runId)!.status));
  expect(f.store.getRun(run.runId)?.status).toBe("succeeded"); expect(f.store.tasks(run.runId)).toHaveLength(2);
  expect(f.store.events(run.runId).some((event) => event.type === "child.reviewed")).toBe(true);
});

test("routing ambiguity automatically appears in the existing question inbox and selection preserves paused work", async () => {
  const f = await fixture({ async *stream() { throw new Error("Paused runs must not request a model"); } });
  await f.runtime.close();
  const runtime = new DurableRuntime(f.store, f.state, f.factory); runtimes.push(runtime);
  for (const id of ["a", "b"]) {
    const { run } = await runtime.submit({ commandId: id, objective: `Task ${id}`, configuration: f.config, mode: "single" });
    runtime.commands.pauseRun({ commandId: `pause-${id}`, runId: run.runId, expectedRevision: run.revision });
  }
  const configDir = dirname(f.state), controller = new AbortController(), ready = Promise.withResolvers<void>();
  const serving = serveDurableRuntime({ configDir, runtime, env: process.env, signal: controller.signal, ready: () => ready.resolve() });
  const inbox = new DurableQuestionInbox({ configDir, workspace: () => f.canonical });
  try {
    await ready.promise; inbox.start();
    const decision = runtime.router.followup({ commandId: "ambiguous", source: { inputId: "original", workspace: f.canonical, rawText: "ORIGINAL-REQUIREMENTS", source: "conversation", sessionId: "chat" } });
    expect(decision.status).toBe("clarify");
    await until(runtime, () => !!inbox.next());
    const notice = inbox.next()!; expect("routing" in notice).toBe(true);
    const question = durableUserQuestion(notice); expect(question.options).toHaveLength(2);
    const answered = await inbox.answer(notice, question.options[0]!.label); expect(answered.paused).toBe(true);
    const current = f.store.route<{ status: string; runId: string }>("original")!;
    expect(current.status).toBe("accepted"); expect(f.store.getRun(current.runId)?.status).toBe("paused");
    expect(f.store.records<TaskInput>("task-input", current.runId)[0]!.value.text).toBe("ORIGINAL-REQUIREMENTS");
    expect(f.effects()).toBe(0);
    const control = await runtimeRequest(configDir, "/command", { action: "route-control", commandId: "control-question", routeAction: "cancel",
      source: { inputId: "original-control", workspace: f.canonical, rawText: "Cancel that task", source: "conversation", sessionId: "chat" } }) as { revision: number };
    await until(runtime, () => inbox.current().some((notice) => "routing" in notice && notice.inputId === "original-control"));
    const controlNotice = inbox.current().find((notice) => "routing" in notice && notice.inputId === "original-control")!;
    const selected = durableUserQuestion(controlNotice).options[0]!.label;
    await inbox.answer(controlNotice, selected);
    const done = f.store.route<{ status: string; runId: string; rawText: string; revision: number }>("original-control")!;
    expect(done).toMatchObject({ status: "accepted", rawText: "Cancel that task", revision: control.revision + 1 });
    expect(["cancelling", "cancelled"]).toContain(f.store.getRun(done.runId)!.status);
    expect(f.store.records("task-input", done.runId).every((record) => (record.value as TaskInput).text !== "Cancel that task")).toBe(true);
  } finally { await inbox.close(); controller.abort(); await serving; }
});

test("an unverified proposal is refused durably without creating a child", async () => {
  let requests = 0;
  const f = await fixture({ async *stream() {
    if (++requests === 1) yield* call("agent", { key: "fake", prompt: "Independent question", reason: "Independent investigation", scope: ["."],
      evidenceRefs: ["tool:never-executed"], deliverable: "Report", acceptance: "Evidence", required: true, maxTurns: 3, maxRequests: 2 });
    else yield* report("Continued directly after rejected proposal");
  } });
  const { run } = await f.runtime.submit({ commandId: "create", objective: "Inspect", configuration: f.config });
  await until(f.runtime, () => ["succeeded", "paused", "failed"].includes(f.store.getRun(run.runId)!.status));
  expect(f.store.getRun(run.runId)?.status).toBe("succeeded"); expect(f.store.tasks(run.runId)).toHaveLength(1);
  expect(f.store.events(run.runId).some((event) => event.type === "delegation.rejected")).toBe(true);
});

test("an auxiliary failed branch requires an explicit takeover and remains disclosed in the final artifact", async () => {
  let parentRequests = 0;
  const f = await fixture({ async *stream(input) {
    if (input.systemPrompt?.includes('"contract":{')) { yield* report(JSON.stringify({ summary: "Unverified claim", evidenceRefs: ["tool:invented"], uncertainties: [] })); return; }
    if (++parentRequests === 1) yield* call("agent", { key: "aux", prompt: "Optional investigation", reason: "Independent optional evidence", scope: ["."], evidenceRefs: ["input"],
      deliverable: "Evidence report", acceptance: "Cite real evidence", required: false, maxTurns: 4, maxRequests: 4 });
    else if (parentRequests === 2) {
      const child = f.store.runs().flatMap((run) => f.store.tasks(run.runId)).find((task) => task.parentTaskId)!;
      yield* call("review_child_result", { taskId: child.taskId, outcome: "takeover", reason: "Took over and retained the missing-evidence limitation", evidenceRefs: ["input"] });
    } else yield* report("Parent finished within original scope");
  } });
  const { run } = await f.runtime.submit({ commandId: "create", objective: "Deliver with optional research", configuration: f.config });
  await until(f.runtime, () => ["succeeded", "paused", "failed"].includes(f.store.getRun(run.runId)!.status));
  expect(f.store.getRun(run.runId)?.status).toBe("succeeded");
  const root = f.store.tasks(run.runId).find((task) => !task.parentTaskId)!;
  const result = await f.runtime.artifacts.get<{ report: string }>(root.resultRef!);
  expect(result.report).toContain("Auxiliary limitations"); expect(result.report).toContain("Unverified evidence reference");
});

test("a transcript delivery committed before a crash is not appended twice when its inbox receipt recovers", async () => {
  let requests = 0;
  const f = await fixture({ async *stream(input) {
    requests++; expect(JSON.stringify(input.messages).match(/User follow-up input recover-input/g)).toHaveLength(1); yield* report("Recovered requirement");
  } });
  await f.runtime.close();
  const runtime = new DurableRuntime(f.store, f.state, f.factory); runtimes.push(runtime);
  const { run } = await runtime.submit({ commandId: "create", objective: "Recover input", configuration: f.config, mode: "single" });
  runtime.router.followup({ commandId: "incoming", runId: run.runId, source: { inputId: "recover-input", workspace: f.canonical, rawText: "Keep this requirement", source: "api" } });
  const command = f.store.command.bind(f.store); let crash = true;
  f.store.command = ((id: string, value: unknown, now: number, apply: never) => {
    if (crash && (value as { kind?: string }).kind === "input.delivered") { crash = false; throw new Error("Crash after durable delivery before inbox receipt"); }
    return command(id, value, now, apply);
  }) as typeof f.store.command;
  await runtime.start(); await until(runtime, () => f.store.getRun(run.runId)?.status === "paused");
  expect(requests).toBe(0); expect(f.store.records<TaskInput>("task-input", run.runId)[0]!.value.state).toBe("pending");
  await runtime.close(); f.store.close();
  const store = new RuntimeStore(f.database); stores.push(store); const resumed = new DurableRuntime(store, f.state, f.factory); runtimes.push(resumed);
  await resumed.start(); await resumed.resume(run.runId);
  await until(resumed, () => ["succeeded", "failed", "paused"].includes(store.getRun(run.runId)!.status));
  expect(store.getRun(run.runId)?.status).toBe("succeeded"); expect(requests).toBe(1);
  expect(store.records<TaskInput>("task-input", run.runId)[0]!.value.state).toBe("delivered");
});

test("structured child submission survives a journal receipt failure without another child model request", async () => {
  let childRequests = 0, rootRequests = 0; let currentStore: RuntimeStore;
  const f = await fixture({ async *stream(input) {
    if (input.systemPrompt?.includes('"contract":{')) { childRequests++; yield* call("complete_investigation", { summary: "Original input investigated", evidenceRefs: ["input"], uncertainties: ["No code facts asserted"] }); return; }
    if (++rootRequests === 1) yield* call("agent", { key: "once", prompt: "Independent input investigation", reason: "Separate bounded evidence", scope: ["."], evidenceRefs: ["input"],
      deliverable: "Evidence report", acceptance: "Disclose uncertainty", required: true, maxTurns: 4, maxRequests: 4 });
    else if (rootRequests === 2) {
      const child = currentStore.runs().flatMap((run) => currentStore.tasks(run.runId)).find((task) => task.parentTaskId)!;
      yield* call("review_child_result", { taskId: child.taskId, resultRef: child.resultRef, outcome: "accept", reason: "Checked original input and disclosed gaps", evidenceRefs: ["input"] });
    } else yield* report("Integrated original child report");
  } });
  currentStore = f.store;
  const command = f.store.command.bind(f.store); let crash = true;
  f.store.command = ((id: string, value: unknown, now: number, apply: never) => {
    const event = value as { kind?: string; state?: string; operationId?: string };
    if (crash && event.kind === "operation.mirror" && event.state === "settled"
      && f.store.record<{ call: { name: string } }>("operation", event.operationId!)?.value.call.name === "complete_investigation") { crash = false; throw new Error("Crash after submitted report and journal fsync"); }
    return command(id, value, now, apply);
  }) as typeof f.store.command;
  const { run } = await f.runtime.submit({ commandId: "create", objective: "Delegate and recover exact report", configuration: f.config });
  await until(f.runtime, () => f.store.getRun(run.runId)?.status === "paused");
  expect(childRequests).toBe(1);
  await f.runtime.close(); f.store.close();
  const store = new RuntimeStore(f.database); stores.push(store); currentStore = store;
  const runtime = new DurableRuntime(store, f.state, f.factory); runtimes.push(runtime); await runtime.start(); await runtime.resume(run.runId);
  await until(runtime, () => ["succeeded", "failed", "paused"].includes(store.getRun(run.runId)!.status));
  expect(store.getRun(run.runId)?.status).toBe("succeeded"); expect(childRequests).toBe(1);
  const child = store.tasks(run.runId).find((task) => task.parentTaskId)!;
  expect(store.record("submitted-report", child.taskId)?.revision).toBe(1);
  expect(store.records("submitted-report", run.runId)).toHaveLength(1);
});
