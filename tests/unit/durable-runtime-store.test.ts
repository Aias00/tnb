import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore, type StoreLimits } from "../../src/services/runtime/store";
import { RuntimeCommands } from "../../src/services/runtime/commands";
import { digestJson, encodeJson } from "../../src/services/runtime/json";
import { assertTaskTransition, type DurableAttempt } from "../../src/services/runtime/types";

const roots: string[] = [];
const stores: RuntimeStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(limits?: Partial<StoreLimits>) {
  const root = await mkdtemp(join(tmpdir(), "tnb-durable-store-")); roots.push(root);
  const path = join(root, "runtime", "state.sqlite");
  let now = 1000;
  const store = new RuntimeStore(path, limits); stores.push(store);
  return { path, store, commands: new RuntimeCommands(store, () => now), time: (value: number) => { now = value; } };
}
const definition = (key: string, dependsOn: string[] = []) => ({ key, objective: `Do ${key}`, inputDigest: digestJson({ key }), dependsOn });
const identity = (attempt: DurableAttempt) => ({ attemptId: attempt.attemptId, ownerId: attempt.ownerId, epoch: attempt.epoch });

test("owner notifications follow committed mutations only and deadlines respect leases and paused Runs", async () => {
  const f = await fixture(); let changes = 0;
  const remove = f.store.onChange(() => { changes++; });
  f.store.command("noop", {}, 1000, () => true); expect(changes).toBe(0);
  expect(() => f.store.command("rollback", {}, 1000, (tx) => {
    tx.insertRun({ runId: "rollback", objective: "rollback", revision: 1, status: "active", policy: { mode: "single", maxActiveAgents: 1, maxDelegationDepth: 0 }, createdAt: 1000, updatedAt: 1000 });
    throw new Error("rollback");
  })).toThrow("rollback"); expect(changes).toBe(0);
  const input = { commandId: "due", objective: "Wait for due work" };
  const { run } = f.commands.createRun(input); expect(changes).toBe(1);
  f.commands.createRun(input); expect(changes).toBe(1);
  expect(f.store.nextDueAt()).toBe(1000);
  const effect = f.store.claimEffects({ ownerId: "owner", now: 1000, leaseMs: 4000 })[0]!;
  expect(f.store.nextDueAt()).toBe(5000);
  f.store.settleEffect(effect.effectId, effect.leaseToken!, 1001, 6000);
  expect(f.store.nextDueAt()).toBe(6000);
  f.commands.pauseRun({ commandId: "pause-due", runId: run.runId, expectedRevision: run.revision });
  expect(f.store.nextDueAt()).toBe(1000); // The control row remains eligible.
  const control = f.store.claimEffects({ ownerId: "owner", now: 1001, leaseMs: 1000 })[0]!;
  expect(control.kind).toBe("control"); f.store.settleEffect(control.effectId, control.leaseToken!, 1002);
  expect(f.store.nextDueAt()).toBeUndefined();
  remove();
});
function counts(path: string) {
  const db = new Database(path, { readonly: true });
  try { return Object.fromEntries(["runs", "tasks", "commands", "events", "effects", "attempts"].map((table) =>
    [table, (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n])); }
  finally { db.close(); }
}

test("creation persists a dependency graph, event order and independent immutable query snapshots", async () => {
  const f = await fixture();
  const created = f.commands.createRun({ commandId: "create", objective: "Migrate", tasks: [definition("inspect"), definition("change", ["inspect"])] });
  expect(created.tasks.map((task) => task.status)).toEqual(["ready", "waiting"]);
  expect(created.tasks[1]!.dependsOn).toEqual([created.tasks[0]!.taskId]);
  expect(f.store.events(created.run.runId).map((event) => event.sequence)).toEqual([1, 2, 3]);
  expect(f.store.effects(created.run.runId)).toHaveLength(1);
  const before = counts(f.path);
  created.tasks[0]!.status = "succeeded";
  f.store.getRun(created.run.runId)!.objective = "not persisted";
  expect(f.store.getTask(created.tasks[0]!.taskId)?.status).toBe("ready");
  expect(f.store.getRun(created.run.runId)?.objective).toBe("Migrate");
  expect(counts(f.path)).toEqual(before);
  expect(f.store.events(created.run.runId, 1, 1)[0]?.sequence).toBe(2);
});

test("command retries survive reopen, return original receipts, and reject conflicting reuse", async () => {
  const f = await fixture();
  const input = { commandId: "create", objective: "Inspect" };
  const first = f.commands.createRun(input);
  f.commands.pauseRun({ commandId: "pause", runId: first.run.runId, expectedRevision: 1 });
  const before = counts(f.path);
  f.store.close();
  const reopened = new RuntimeStore(f.path); stores.push(reopened);
  const commands = new RuntimeCommands(reopened, () => 9000);
  expect(commands.createRun(input)).toEqual(first); // Receipt is not a fresh status query.
  expect(reopened.getRun(first.run.runId)?.status).toBe("paused");
  expect(() => commands.createRun({ ...input, objective: "Different work" })).toThrow("different input");
  expect(counts(f.path)).toEqual(before);
});

test("JSON command identity is canonical and bounded, rejecting non-JSON payloads", () => {
  expect(digestJson({ b: [1, 2], a: 1 })).toBe(digestJson({ a: 1, b: [1, 2] }));
  expect(digestJson([1, 2])).not.toBe(digestJson([2, 1]));
  expect(() => encodeJson({ x: Infinity })).toThrow("JSON values");
  expect(() => encodeJson({ at: new Date() })).toThrow("plain JSON");
  const cycle: { value?: unknown } = {}; cycle.value = cycle;
  expect(() => encodeJson(cycle)).toThrow("cycle");
  expect(() => encodeJson("x".repeat(100), 10)).toThrow("byte limit");
});

test("invalid graphs and a full queue roll back run, tasks, events and command receipt together", async () => {
  const f = await fixture({ maxEffectsPerRun: 1 });
  for (const tasks of [[definition("a"), definition("a")], [definition("a", ["missing"])], [definition("a", ["b"]), definition("b", ["a"])]]) {
    expect(() => f.commands.createRun({ commandId: "invalid", objective: "Work", tasks })).toThrow();
  }
  const input = { commandId: "retry-after-rollback", objective: "Work", tasks: [definition("a"), definition("b")] };
  expect(() => f.commands.createRun(input)).toThrow("queue is full");
  expect(counts(f.path)).toEqual({ runs: 0, tasks: 0, commands: 0, events: 0, effects: 0, attempts: 0 });
  f.store.close();
  const reopened = new RuntimeStore(f.path, { maxEffectsPerRun: 2 }); stores.push(reopened);
  const result = new RuntimeCommands(reopened, () => 2000).createRun(input);
  expect(result.tasks).toHaveLength(2);
  expect(counts(f.path).commands).toBe(1);
});

test("stale revisions reject without receipt, allowing an explicit corrected retry", async () => {
  const f = await fixture(); const { run } = f.commands.createRun({ commandId: "create", objective: "Work" });
  const paused = f.commands.pauseRun({ commandId: "pause", runId: run.runId, expectedRevision: 1 });
  const before = counts(f.path);
  expect(() => f.commands.resumeRun({ commandId: "resume", runId: run.runId, expectedRevision: 1 })).toThrow("revision conflict");
  expect(counts(f.path)).toEqual(before);
  expect(f.commands.resumeRun({ commandId: "resume", runId: run.runId, expectedRevision: paused.revision }).status).toBe("active");
});

test("one active attempt per Run, strict worker identity and expired leases protect result state", async () => {
  const f = await fixture();
  const { run, tasks } = f.commands.createRun({ commandId: "create", objective: "Work", tasks: [definition("a"), definition("b")] });
  const active = f.commands.startAttempt({ commandId: "start", taskId: tasks[0]!.taskId, expectedRevision: 1, ownerId: "worker-a", leaseMs: 100 });
  expect(() => f.commands.startAttempt({ commandId: "other", taskId: tasks[1]!.taskId, expectedRevision: 1, ownerId: "worker-b", leaseMs: 100 })).toThrow("capacity");
  const finish = { commandId: "finish", taskId: active.task.taskId, expectedRevision: active.task.revision,
    worker: identity(active.attempt), next: "validating" as const, checkpointRef: "checkpoint:1", candidateRef: "artifact:1" };
  const before = counts(f.path);
  expect(() => f.commands.finishAttempt({ ...finish, worker: { ...finish.worker, ownerId: "intruder" } })).toThrow("Stale or unauthorized");
  expect(() => f.commands.finishAttempt({ ...finish, worker: { ...finish.worker, epoch: 2 } })).toThrow("Stale or unauthorized");
  f.time(1100);
  expect(() => f.commands.finishAttempt(finish)).toThrow("Stale or unauthorized");
  expect(counts(f.path)).toEqual(before);
  expect(f.store.getTask(active.task.taskId)?.status).toBe("running");
  expect(f.store.getRun(run.runId)?.status).toBe("active"); // Queries do not fabricate recovery.
});

test("a new attempt retains task identity and rejects a delayed result from its predecessor", async () => {
  const f = await fixture(); const { run, tasks } = f.commands.createRun({ commandId: "create", objective: "Work" });
  const first = f.commands.startAttempt({ commandId: "start-1", taskId: tasks[0]!.taskId, expectedRevision: 1, ownerId: "first", leaseMs: 1000 });
  const waiting = f.commands.finishAttempt({ commandId: "wait", taskId: first.task.taskId, expectedRevision: first.task.revision,
    worker: identity(first.attempt), next: "waiting", checkpointRef: "checkpoint:wait", wait: { kind: "message", key: "reply", afterGeneration: 0 } });
  expect(waiting.status).toBe("waiting");
  f.commands.postSignal({ commandId: "reply", runId: run.runId, kind: "message", key: "reply", data: "continue" });
  const current = f.store.getTask(waiting.taskId)!;
  const second = f.commands.startAttempt({ commandId: "start-2", taskId: current.taskId, expectedRevision: current.revision, ownerId: "second", leaseMs: 1000 });
  expect(second.attempt.epoch).toBe(2);
  expect(second.task.checkpointRef).toBe("checkpoint:wait");
  expect(() => f.commands.finishAttempt({ commandId: "late", taskId: current.taskId, expectedRevision: second.task.revision,
    worker: identity(first.attempt), next: "failed", checkpointRef: "bad" })).toThrow("Stale or unauthorized");
  expect(f.store.getTask(current.taskId)?.currentAttemptId).toBe(second.attempt.attemptId);
});

test("pause drains the active attempt and retains its wait across restart and resume", async () => {
  const f = await fixture(); const { run, tasks } = f.commands.createRun({ commandId: "create", objective: "Work" });
  const first = f.commands.startAttempt({ commandId: "start", taskId: tasks[0]!.taskId, expectedRevision: 1, ownerId: "worker", leaseMs: 1000 });
  const pausing = f.commands.pauseRun({ commandId: "pause", runId: run.runId, expectedRevision: 1 });
  expect(pausing.status).toBe("pausing");
  expect(() => f.commands.resumeRun({ commandId: "too-soon", runId: run.runId, expectedRevision: pausing.revision })).toThrow("cannot resume");
  f.commands.finishAttempt({ commandId: "finish", taskId: first.task.taskId, expectedRevision: first.task.revision,
    worker: identity(first.attempt), next: "waiting", checkpointRef: "checkpoint:paused", wait: { kind: "approval", key: "approve", afterGeneration: 0 } });
  expect(f.store.getRun(run.runId)?.status).toBe("paused");
  f.commands.postSignal({ commandId: "approval", runId: run.runId, kind: "approval", key: "approve", data: { allowed: true } });
  expect(f.store.getTask(first.task.taskId)?.status).toBe("paused");
  f.store.close();
  const reopened = new RuntimeStore(f.path); stores.push(reopened);
  const commands = new RuntimeCommands(reopened, () => 1200);
  commands.resumeRun({ commandId: "resume", runId: run.runId, expectedRevision: reopened.getRun(run.runId)!.revision });
  expect(reopened.getTask(first.task.taskId)?.status).toBe("ready");
  expect(reopened.getTask(first.task.taskId)?.checkpointRef).toBe("checkpoint:paused");
  expect(reopened.effects(run.runId).find((row) => row.kind === "control")?.data).toMatchObject({ action: "resume" });
});

test("cancel remains durable and late completion becomes reconciliation, not successful cancellation", async () => {
  const f = await fixture(); const { run, tasks } = f.commands.createRun({ commandId: "create", objective: "Work" });
  const active = f.commands.startAttempt({ commandId: "start", taskId: tasks[0]!.taskId, expectedRevision: 1, ownerId: "worker", leaseMs: 1000 });
  const cancelled = f.commands.cancelRun({ commandId: "cancel", runId: run.runId, expectedRevision: 1 });
  expect(cancelled.status).toBe("cancelling");
  const result = f.commands.finishAttempt({ commandId: "late", taskId: active.task.taskId, expectedRevision: active.task.revision,
    worker: identity(active.attempt), next: "validating", checkpointRef: "checkpoint:late", candidateRef: "artifact:late" });
  expect(result.status).toBe("reconciling"); expect(result.candidateRef).toBe("artifact:late");
  expect(() => f.commands.resumeRun({ commandId: "resume", runId: run.runId, expectedRevision: cancelled.revision })).toThrow("cannot resume");
  f.store.close(); const reopened = new RuntimeStore(f.path); stores.push(reopened);
  expect(reopened.getRun(run.runId)?.cancelRequestedAt).toBe(1000);
  expect(reopened.getRun(run.runId)?.status).toBe("cancelling");
  expect(reopened.getTask(result.taskId)?.status).toBe("reconciling");
});

for (const ordering of ["signal-first", "wait-first"] as const) {
  test(`wait registration cannot lose a ${ordering} signal and duplicate commands cannot wake twice`, async () => {
    const f = await fixture(); const { run, tasks } = f.commands.createRun({ commandId: "create", objective: "Work" });
    const signal = { commandId: "signal", runId: run.runId, kind: "message" as const, key: "answer", data: "done" };
    if (ordering === "signal-first") f.commands.postSignal(signal);
    f.commands.waitFor({ commandId: "wait", taskId: tasks[0]!.taskId, expectedRevision: 1, condition: { kind: "message", key: "answer", afterGeneration: 0 } });
    f.commands.postSignal(signal);
    const before = counts(f.path);
    f.commands.postSignal(signal);
    expect(f.store.getTask(tasks[0]!.taskId)?.status).toBe("ready");
    expect(f.store.events(run.runId).filter((event) => event.type === "task.woken")).toHaveLength(1);
    expect(counts(f.path)).toEqual(before);
  });
}

test("a persisted condition without notification is recovered by an explicit scan, never by queries", async () => {
  const f = await fixture(); const { run, tasks } = f.commands.createRun({ commandId: "create", objective: "Work" });
  f.commands.waitFor({ commandId: "wait", taskId: tasks[0]!.taskId, expectedRevision: 1, condition: { kind: "resource", key: "slot", afterGeneration: 0 } });
  f.store.command("signal-only", { fixture: "missed notification" }, 1000, (tx) => tx.signal(run.runId, "resource", "slot", true));
  f.store.close(); const reopened = new RuntimeStore(f.path); stores.push(reopened);
  const commands = new RuntimeCommands(reopened, () => 1100);
  const before = counts(f.path);
  expect(reopened.getTask(tasks[0]!.taskId)?.status).toBe("waiting");
  expect(counts(f.path)).toEqual(before);
  expect(commands.scanWaiting({ commandId: "scan", runId: run.runId })).toEqual([tasks[0]!.taskId]);
  expect(commands.scanWaiting({ commandId: "scan-again", runId: run.runId })).toEqual([]);
});

test("old signals do not satisfy a later wait and new generations do", async () => {
  const f = await fixture(); const { run, tasks } = f.commands.createRun({ commandId: "create", objective: "Work" });
  f.commands.postSignal({ commandId: "old", runId: run.runId, kind: "message", key: "reply", data: 1 });
  f.commands.waitFor({ commandId: "wait", taskId: tasks[0]!.taskId, expectedRevision: 1, condition: { kind: "message", key: "reply", afterGeneration: 1 } });
  expect(f.store.getTask(tasks[0]!.taskId)?.status).toBe("waiting");
  f.commands.postSignal({ commandId: "new", runId: run.runId, kind: "message", key: "reply", data: 2 });
  expect(f.store.getTask(tasks[0]!.taskId)?.status).toBe("ready");
  expect(f.store.getSignal(run.runId, "message", "reply")?.generation).toBe(2);
});

test("old effect completion cannot delete a replacement payload or overwrite its retry policy", async () => {
  const f = await fixture(); const { run, tasks } = f.commands.createRun({ commandId: "create", objective: "Work" });
  const old = f.store.claimEffects({ ownerId: "first", now: 1000, leaseMs: 1000 })[0]!;
  f.store.command("replace", { replacement: true }, 1010, (tx) => {
    tx.enqueue({ runId: run.runId, taskId: tasks[0]!.taskId, kind: "schedule", key: tasks[0]!.taskId, dueAt: 1010, data: { latest: true } });
    return true;
  });
  expect(f.store.claimEffects({ ownerId: "second", now: 1010, leaseMs: 1000 })).toEqual([]);
  expect(f.store.settleEffect(old.effectId, old.leaseToken!, 1020, 9000)).toBe("superseded");
  const current = f.store.claimEffects({ ownerId: "second", now: 1020, leaseMs: 1000 })[0]!;
  expect(current.data).toEqual({ latest: true }); expect(current.attempts).toBe(0);
  expect(f.store.settleEffect(old.effectId, old.leaseToken!, 1030)).toBe("stale");
  expect(f.store.settleEffect(current.effectId, current.leaseToken!, 1030)).toBe("settled");
  expect(f.store.effects(run.runId)).toEqual([]);
});

test("effect leases, retries and FIFO order survive reopen and reject expired acknowledgements", async () => {
  const f = await fixture(); const { run } = f.commands.createRun({ commandId: "create", objective: "Work", tasks: [definition("a"), definition("b")] });
  const first = f.store.claimEffects({ ownerId: "one", now: 1000, leaseMs: 10 })[0]!;
  expect(f.store.settleEffect(first.effectId, first.leaseToken!, 1010)).toBe("stale");
  f.store.close(); const reopened = new RuntimeStore(f.path); stores.push(reopened);
  const recovered = reopened.claimEffects({ ownerId: "two", now: 1010, leaseMs: 100 })[0]!;
  expect(recovered.effectId).toBe(first.effectId); expect(recovered.leaseToken).not.toBe(first.leaseToken);
  expect(reopened.settleEffect(recovered.effectId, recovered.leaseToken!, 1020, 1100)).toBe("settled");
  const other = reopened.claimEffects({ ownerId: "two", now: 1020, leaseMs: 100 })[0]!;
  expect(other.sequence).toBeGreaterThan(first.sequence);
  reopened.settleEffect(other.effectId, other.leaseToken!, 1030);
  expect(reopened.claimEffects({ ownerId: "two", now: 1099, leaseMs: 100 })).toEqual([]);
  expect(reopened.claimEffects({ ownerId: "two", now: 1100, leaseMs: 100 })[0]?.attempts).toBe(1);
  expect(reopened.effects(run.runId)).toHaveLength(1);
});

test("pause and cancel reserve one coalesced control slot even when the business queue is full", async () => {
  const f = await fixture({ maxEffects: 1, maxEffectsPerRun: 1 });
  const { run } = f.commands.createRun({ commandId: "create", objective: "Work" });
  const paused = f.commands.pauseRun({ commandId: "pause", runId: run.runId, expectedRevision: 1 });
  expect(f.store.claimEffects({ ownerId: "dispatcher", now: 1000, leaseMs: 100 })[0]?.kind).toBe("control");
  f.commands.cancelRun({ commandId: "cancel", runId: run.runId, expectedRevision: paused.revision });
  expect(f.store.effects(run.runId)).toHaveLength(2);
  expect(f.store.effects(run.runId).filter((effect) => effect.kind === "control")).toHaveLength(1);
  expect(f.store.effects(run.runId).find((effect) => effect.kind === "control")?.data).toMatchObject({ action: "cancel" });
});

test("Run admission is bounded, deadline and single-mode constraints reject new work", async () => {
  const f = await fixture({ maxActiveRuns: 1 });
  expect(() => f.commands.createRun({ commandId: "bad-mode", objective: "Work", policy: { mode: "single", maxDelegationDepth: 1 } })).toThrow("Single mode");
  const { run, tasks } = f.commands.createRun({ commandId: "create", objective: "Work", deadline: 1001 });
  expect(() => f.commands.createRun({ commandId: "over-capacity", objective: "More work" })).toThrow("run capacity");
  f.time(1001);
  expect(() => f.commands.startAttempt({ commandId: "start", taskId: tasks[0]!.taskId, expectedRevision: 1, ownerId: "worker", leaseMs: 10 })).toThrow("deadline");
  expect(f.commands.pauseRun({ commandId: "pause", runId: run.runId, expectedRevision: 1 }).status).toBe("paused");
});

test("terminal task transitions and unverified success are refused", () => {
  for (const state of ["succeeded", "failed", "cancelled"] as const) expect(() => assertTaskTransition(state, "running")).toThrow("Invalid durable");
  expect(() => assertTaskTransition("running", "succeeded")).toThrow();
  expect(() => assertTaskTransition("validating", "succeeded")).not.toThrow();
});

test("storage rejects illegal state transitions and input rewrites even inside internal transactions", async () => {
  const f = await fixture(); const { run, tasks } = f.commands.createRun({ commandId: "create", objective: "Work" });
  const before = counts(f.path);
  expect(() => f.store.command("illegal-state", {}, 1000, (tx) => {
    const task = tx.getTask(tasks[0]!.taskId)!;
    tx.saveTask({ ...task, revision: 2, status: "succeeded" }, 1);
    return true;
  })).toThrow("Invalid durable task transition");
  expect(() => f.store.command("input-rewrite", {}, 1000, (tx) => {
    const task = tx.getTask(tasks[0]!.taskId)!;
    tx.saveTask({ ...task, revision: 2, inputDigest: digestJson("other input") }, 1);
    return true;
  })).toThrow("identity and inputs");
  expect(() => f.store.command("revision-skip", {}, 1000, (tx) => {
    tx.saveRun({ ...run, revision: 3 }, 1); return true;
  })).toThrow("advance by one");
  expect(counts(f.path)).toEqual(before);
});

test("async or leaked transaction callbacks cannot write after rollback", async () => {
  const f = await fixture(); const { run } = f.commands.createRun({ commandId: "create", objective: "Work" });
  let later!: () => void;
  const gate = new Promise<void>((resolve) => { later = resolve; });
  expect(() => f.store.command("async", { invalid: true }, 1000, async (tx) => {
    await gate;
    tx.event(run.runId, "must-not-escape", {});
    return true;
  })).toThrow("synchronous");
  later(); await Promise.resolve(); await Promise.resolve();
  expect(f.store.events(run.runId).some((event) => event.type === "must-not-escape")).toBe(false);
});

test("database permissions are private and unrecognized/newer schemas are preserved", async () => {
  const f = await fixture(); expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  const path = join(roots[roots.length - 1]!, "future.sqlite");
  const db = new Database(path); db.exec("CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES ('keep'); PRAGMA user_version = 999;"); db.close();
  expect(() => new RuntimeStore(path)).toThrow("Unsupported runtime schema");
  const check = new Database(path, { readonly: true });
  expect(check.query("SELECT value FROM future_data").get()).toEqual({ value: "keep" }); check.close();
  const unknown = join(roots[roots.length - 1]!, "unknown.sqlite");
  const old = new Database(unknown); old.exec("CREATE TABLE not_runtime(value TEXT)"); old.close();
  expect(() => new RuntimeStore(unknown)).toThrow("Unrecognized runtime database");
  const foreign = new Database(unknown); foreign.exec("PRAGMA user_version = 1"); foreign.close();
  expect(() => new RuntimeStore(unknown)).toThrow("Unrecognized runtime database identity");
});
