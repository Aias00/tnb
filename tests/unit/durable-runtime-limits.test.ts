// Extending a Run must preserve pause/authority, replay once, and retain uncertain charges.
import { afterEach, expect, test } from "bun:test";
import { RuntimeStore } from "../../src/services/runtime/store";
import { RuntimeCommands } from "../../src/services/runtime/commands";
import { DurableWaits } from "../../src/services/runtime/waits";

const stores: RuntimeStore[] = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); });
function fixture() {
  let now = 1000;
  const store = new RuntimeStore(":memory:"); stores.push(store);
  const commands = new RuntimeCommands(store, () => now);
  const created = commands.createRun({ commandId: "create", objective: "Long task", deadline: 2000, configuration: { maxCostUsd: 1 } });
  return { store, commands, ...created, time: (time: number) => { now = time; }, waits: new DurableWaits(store, () => now) };
}
test("a paused expired Run can be extended once without resuming or changing execution permissions", () => {
  const f = fixture();
  const paused = f.commands.pauseRun({ commandId: "pause", runId: f.run.runId, expectedRevision: f.run.revision }); f.time(3000);
  const input = { commandId: "extend", runId: f.run.runId, expectedRevision: paused.revision, extendMs: 10000, maxCostUsd: 2 };
  const changed = f.commands.updateLimits(input);
  expect(changed.deadline).toBe(13000); expect(changed.status).toBe("paused");
  expect(f.commands.updateLimits(input)).toEqual(changed);
  expect(f.store.record("configuration", f.run.runId)?.value).toEqual({ maxCostUsd: 2 });
  expect(f.store.record("binding-limits", f.run.runId)?.value).toEqual({ maxCostUsd: 1 });
  expect(f.store.record("run-limits", f.run.runId)?.value).toMatchObject({ maxCostUsd: 2 });
  expect(f.store.events(f.run.runId).filter((event) => event.type === "run.limits-updated")).toHaveLength(1);
  expect(f.commands.resumeRun({ commandId: "resume", runId: f.run.runId, expectedRevision: changed.revision }).status).toBe("active");
});
test("limits require a drained pause, a current revision, and an actual increase", () => {
  const f = fixture();
  expect(() => f.commands.updateLimits({ commandId: "active", runId: f.run.runId, expectedRevision: 1, maxCostUsd: 2 })).toThrow("paused");
  const paused = f.commands.pauseRun({ commandId: "pause", runId: f.run.runId, expectedRevision: 1 });
  expect(() => f.commands.updateLimits({ commandId: "stale", runId: f.run.runId, expectedRevision: 1, maxCostUsd: 2 })).toThrow("revision");
  expect(() => f.commands.updateLimits({ commandId: "lower", runId: f.run.runId, expectedRevision: paused.revision, maxCostUsd: 0.5 })).toThrow();
  expect(() => f.commands.updateLimits({ commandId: "shorter", runId: f.run.runId, expectedRevision: paused.revision, deadline: 1500 })).toThrow();
  expect(() => f.commands.updateLimits({ commandId: "both", runId: f.run.runId, expectedRevision: paused.revision, deadline: 5000, extendMs: 1000 })).toThrow();
});
test("a limit update retains all uncertain reservations and cannot set the ceiling below committed charges", () => {
  const f = fixture(); const paused = f.commands.pauseRun({ commandId: "pause", runId: f.run.runId, expectedRevision: 1 });
  f.store.command("charge", {}, 1000, (tx) => {
    tx.saveRecord({ kind: "model-request", id: "physical-request", runId: f.run.runId, value: { requestId: "physical-request", reserved: 3, reported: 0.5, state: "uncertain", usageCount: 1 } }, 0); return true;
  });
  expect(() => f.commands.updateLimits({ commandId: "insufficient", runId: f.run.runId, expectedRevision: paused.revision, maxCostUsd: 2 })).toThrow("reserved");
  f.commands.updateLimits({ commandId: "enough", runId: f.run.runId, expectedRevision: paused.revision, maxCostUsd: 4 });
  expect(f.store.record("model-request", "physical-request")?.value).toMatchObject({ reserved: 3, reported: 0.5, state: "uncertain" });
});
test("setting a first ceiling also constrains legacy configuration readers", () => {
  const f = fixture();
  f.store.command("unlimited", {}, 1000, (tx) => {
    const configuration = tx.record("configuration", f.run.runId)!;
    tx.saveRecord({ ...configuration, value: { allowWrite: false, allowShell: false } }, configuration.revision); return true;
  });
  const paused = f.commands.pauseRun({ commandId: "pause", runId: f.run.runId, expectedRevision: 1 });
  f.commands.updateLimits({ commandId: "first-limit", runId: f.run.runId, expectedRevision: paused.revision, maxCostUsd: 2 });
  expect(f.store.record("configuration", f.run.runId)?.value).toEqual({ allowWrite: false, allowShell: false, maxCostUsd: 2 });
  expect(f.store.record("binding-limits", f.run.runId)?.value).toEqual({});
});
test("expired questions disappear and the same unanswered question returns after authorized extension", () => {
  const f = fixture();
  const { attempt } = f.commands.startAttempt({ commandId: "attempt", taskId: f.tasks[0]!.taskId, expectedRevision: 1, ownerId: "owner", leaseMs: 60000 });
  const worker = { attemptId: attempt.attemptId, ownerId: "owner", epoch: attempt.epoch };
  const question = f.waits.request(f.tasks[0]!.taskId, worker, { kind: "question", key: "ask", question: "继续吗", about: "继续原任务" });
  f.commands.finishAttempt({ commandId: "park", taskId: f.tasks[0]!.taskId, expectedRevision: f.store.getTask(f.tasks[0]!.taskId)!.revision,
    worker, next: "waiting", checkpointRef: "checkpoint", wait: { kind: "message", key: question.waitId, afterGeneration: 0 } });
  expect(f.waits.questions(f.run.runId)).toHaveLength(1);
  f.time(3000); expect(f.waits.questions(f.run.runId)).toEqual([]);
  expect(() => f.waits.answer({ commandId: "late-answer", runId: f.run.runId, waitId: question.waitId, expectedVersion: 1, answer: "继续" })).toThrow("accepting");
  const paused = f.commands.pauseRun({ commandId: "expired", runId: f.run.runId, expectedRevision: 1, reason: "deadline" });
  const renewed = f.commands.updateLimits({ commandId: "renew", runId: f.run.runId, expectedRevision: paused.revision, deadline: 10000 });
  expect(f.waits.questions(f.run.runId)[0]!.waitId).toBe(question.waitId);
  f.waits.answer({ commandId: "after-renewal", runId: f.run.runId, waitId: question.waitId, expectedVersion: 1, answer: "继续" });
  expect(f.store.getRun(f.run.runId)?.status).toBe("paused");
  f.commands.resumeRun({ commandId: "resume", runId: f.run.runId, expectedRevision: renewed.revision });
  expect(f.store.getTask(f.tasks[0]!.taskId)?.status).toBe("ready");
});
