import { afterEach, expect, test } from "bun:test";
import { RuntimeStore } from "../../src/services/runtime/store";
import { RuntimeCommands } from "../../src/services/runtime/commands";
import { DurableBudget } from "../../src/services/runtime/budget";
import type { ModelRequest, ModelTransport } from "../../src/providers/types";
const stores: RuntimeStore[] = []; const budgets: DurableBudget[] = [];
afterEach(async () => { await Promise.all(budgets.splice(0).map((b) => b.close())); stores.splice(0).forEach((s) => s.close()); });
function fixture() {
  const store = new RuntimeStore(":memory:"); stores.push(store);
  const created = new RuntimeCommands(store).createRun({ commandId: "budget-run", objective: "share budget", tasks: [
    { key: "a", objective: "a", inputDigest: "0".repeat(64) }, { key: "b", objective: "b", inputDigest: "0".repeat(64) },
  ] });
  const budget = new DurableBudget(store); budgets.push(budget);
  const context = { runId: created.run.runId, taskId: created.tasks[0]!.taskId, route: { provider: "fixture", model: "fixture", pricing: { input: 1, output: 1 } }, maxOutputTokens: 100, assertLive() {} };
  return { store, budget, context, ...created };
}
const request: ModelRequest = { model: "fixture", messages: [], tools: [] };
test("bounded summary output limits constrain both reservation and physical requests", async () => {
  const f = fixture(); let physicalLimit: number | undefined;
  const raw: ModelTransport = { async *stream(input) {
    physicalLimit = input.maxOutputTokens;
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
    yield { type: "response-end", reason: "end-turn" };
  } };
  const transport = f.budget.wrap(raw, f.context);
  for await (const _event of transport.stream({ ...request, maxOutputTokens: 10 })) {}
  expect(physicalLimit).toBe(10);
  const charge = f.store.records<{ reserved: number }>("model-request", f.run.runId)[0]!.value;
  expect(charge.reserved).toBeCloseTo((Buffer.byteLength(JSON.stringify({ ...request, maxOutputTokens: 10 })) + 10) / 1_000_000, 9);
  await expect((async () => { for await (const _event of transport.stream({ ...request, maxOutputTokens: 0 })) {} })()).rejects.toThrow("Invalid model output");
  expect(f.store.records("model-request", f.run.runId)).toHaveLength(1);
});
async function drain(transport: ModelTransport) { for await (const _event of transport.stream(request)) { /* consume all usage and close */ } }

test("root and children share reservations; failed unbilled requests remain uncertain after recovery", async () => {
  const f = fixture(); let physical = 0;
  const failed: ModelTransport = { async *stream() { physical++; throw new Error("network lost"); } };
  await expect(drain(f.budget.wrap(failed, { ...f.context, maxCostUsd: 0.00025 }))).rejects.toThrow("network lost");
  expect(f.budget.totals(f.run.runId).uncertain).toBe(1);
  const restored = new DurableBudget(f.store); budgets.push(restored); restored.recover(f.run.runId);
  await expect(drain(restored.wrap(failed, { ...f.context, taskId: f.tasks[1]!.taskId, maxCostUsd: 0.00025 }))).rejects.toThrow("including uncertain");
  expect(physical).toBe(1);
});

test("reported usage persists exactly once per request sequence and complete streams release estimates", async () => {
  const f = fixture();
  await drain(f.budget.wrap({ async *stream() {
    yield { type: "usage", usage: { inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
    yield { type: "response-end", reason: "end-turn" };
  } }, f.context));
  expect(f.budget.totals(f.run.runId)).toEqual({ reported: 0.00001, reserved: 0, uncertain: 0 });
  f.budget.recover(f.run.runId); f.budget.recover(f.run.runId);
  expect(f.budget.totals(f.run.runId).reported).toBe(0.00001);
});

test("unknown pricing blocks budgeted model admission and invalid usage retains uncertainty", async () => {
  const f = fixture(); let calls = 0;
  const raw: ModelTransport = { async *stream() { calls++; yield { type: "usage", usage: { inputTokens: -1, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }; } };
  await expect(drain(f.budget.wrap(raw, { ...f.context, route: { provider: "unknown", model: "unknown" }, maxCostUsd: 1 }))).rejects.toThrow("pricing"); expect(calls).toBe(0);
  await expect(drain(f.budget.wrap(raw, f.context))).rejects.toThrow("Invalid provider usage"); expect(calls).toBe(1);
  expect(f.budget.totals(f.run.runId).uncertain).toBe(1);
});

test("waiting for a model slot consumes no physical request or uncertain reservation", async () => {
  const f = fixture(); let active = 0; let unblock!: () => void;
  const held = new Promise<void>((done) => { unblock = done; });
  const transport = f.budget.wrap({ async *stream() {
    active++; await held; yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
    yield { type: "response-end", reason: "end-turn" };
  } }, f.context);
  const running = Array.from({ length: 4 }, () => drain(transport));
  const deadline = Date.now() + 1000;
  while (active < 4) { if (Date.now() > deadline) throw new Error("requests not admitted"); await Bun.sleep(1); }
  const controller = new AbortController();
  const queued = (async () => { for await (const _event of transport.stream(request, controller.signal)) {} })();
  controller.abort(new Error("cancelled before send"));
  try {
    await expect(queued).rejects.toThrow("cancelled before send");
    expect(f.store.records("model-request", f.run.runId)).toHaveLength(4); expect(active).toBe(4);
  } finally { unblock(); await Promise.all(running); }
  expect(f.budget.totals(f.run.runId).uncertain).toBe(0);
});

test("child request caps retain Run usage and preserve parent integration requests before physical admission", async () => {
  const f = fixture(); let physical = 0;
  const raw: ModelTransport = { async *stream() { physical++;
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
    yield { type: "response-end", reason: "end-turn" };
  } };
  const parent = f.budget.wrap(raw, { ...f.context, runMaxRequests: 4 });
  await drain(parent);
  const child = f.budget.wrap(raw, { ...f.context, taskId: f.tasks[1]!.taskId, parentTaskId: f.tasks[0]!.taskId, maxRequests: 1, runMaxRequests: 4 });
  await drain(child);
  await expect(drain(child)).rejects.toThrow("Child model request limit");
  expect(physical).toBe(2); expect(f.store.records("model-request", f.run.runId)).toHaveLength(2);
  const otherChild = f.budget.wrap(raw, { ...f.context, taskId: "another", parentTaskId: f.tasks[0]!.taskId, maxRequests: 3, runMaxRequests: 4 });
  await expect(drain(otherChild)).rejects.toThrow("reserved for parent");
  await drain(parent); await drain(parent);
  expect(physical).toBe(4);
  await expect(drain(parent)).rejects.toThrow("Run model request limit");
  expect(f.store.records("model-request", f.run.runId)).toHaveLength(4);
});
