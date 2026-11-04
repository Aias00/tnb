import { randomUUID } from "node:crypto";
import { digestJson, integer, text } from "./json";
import { RuntimeStore, type RuntimeTransaction } from "./store";
import { refreshWaits, type DurableWait } from "./waits";
import { assertTaskTransition, type DurableAttempt, type DurableRun, type DurableTask,
  type ExecutionPolicy, type RuntimeSignal, type TaskStatus, type WaitCondition, type WorkerIdentity } from "./types";

export type TaskDefinition = { key: string; objective: string; inputDigest: string; dependsOn?: string[] };
type Command = { commandId: string };
type TaskCommand = Command & { taskId: string; expectedRevision: number };
type RunCommand = Command & { runId: string; expectedRevision: number };

/** Trusted in-process business commands; the owner supplies authenticated IPC and execution. */
export class RuntimeCommands {
  constructor(readonly store: RuntimeStore, private readonly clock: () => number = Date.now) {}

  createRun(input: Command & { objective: string; tasks?: TaskDefinition[]; policy?: Partial<ExecutionPolicy>; deadline?: number; configuration?: unknown }): { run: DurableRun; tasks: DurableTask[] } {
    return this.#command(input, "run.create", (tx) => {
      text(input.objective, "run objective");
      if (input.deadline !== undefined) integer(input.deadline, "run deadline", tx.now + 1);
      const policy = normalizePolicy(input.policy);
      const definitions = input.tasks ?? [{ key: "main", objective: input.objective, inputDigest: digestJson({ objective: input.objective }) }];
      validateGraph(definitions);
      const run: DurableRun = { runId: randomUUID(), objective: input.objective, revision: 1, status: "active", policy,
        createdAt: tx.now, updatedAt: tx.now, deadline: input.deadline ?? tx.now + 24 * 60 * 60_000 };
      tx.insertRun(run);
      if (input.configuration !== undefined) tx.saveRecord({ kind: "configuration", id: run.runId, runId: run.runId, value: input.configuration }, 0);
      tx.event(run.runId, "run.created", run);
      const ids = new Map(definitions.map((definition) => [definition.key, randomUUID()]));
      const tasks: DurableTask[] = definitions.map((definition) => ({
        taskId: ids.get(definition.key)!, runId: run.runId, key: definition.key, objective: definition.objective,
        inputDigest: definition.inputDigest, dependsOn: (definition.dependsOn ?? []).map((key) => ids.get(key)!),
        revision: 1, status: definition.dependsOn?.length ? "waiting" : "ready", epoch: 0,
        createdAt: tx.now, updatedAt: tx.now,
      }));
      for (const task of tasks) tx.insertTask(task);
      for (const task of tasks) {
        for (const dependency of task.dependsOn) tx.addDependency(task.taskId, dependency);
        tx.event(run.runId, "task.created", task, task.taskId);
        if (task.status === "ready") schedule(tx, task);
      }
      return { run, tasks };
    });
  }

  /** Reserve an attempt in storage only. No process or tool is launched by this command. */
  startAttempt(input: TaskCommand & { ownerId: string; leaseMs: number }): { task: DurableTask; attempt: DurableAttempt } {
    return this.#command(input, "attempt.start", (tx) => {
      const task = requireTask(tx, input.taskId, input.expectedRevision);
      const run = requireRun(tx, task.runId);
      requireActive(run, tx.now);
      if (task.status !== "ready" || !dependenciesSatisfied(tx, task)) throw new Error("Task is not ready");
      if (tx.activeAttempts(run.runId).filter((attempt) => !attempt.suspended).length >= run.policy.maxActiveAgents) throw new Error("Run agent capacity is occupied");
      text(input.ownerId, "attempt owner", 128); integer(input.leaseMs, "attempt lease", 1, 600_000);
      const attempt: DurableAttempt = { attemptId: randomUUID(), taskId: task.taskId, ownerId: input.ownerId,
        epoch: task.epoch + 1, status: "active", leaseExpiresAt: integer(tx.now + input.leaseMs, "attempt expiry"), createdAt: tx.now };
      tx.insertAttempt(attempt);
      const previous = task.revision;
      assertTaskTransition(task.status, "running");
      task.status = "running"; task.epoch = attempt.epoch; task.currentAttemptId = attempt.attemptId;
      task.revision++; task.updatedAt = tx.now;
      delete task.wait; delete task.resumeState; delete task.error; delete task.candidateRef;
      tx.saveTask(task, previous);
      tx.event(run.runId, "attempt.started", { ...attempt, taskRevision: task.revision, taskStatus: task.status }, task.taskId);
      return { task, attempt };
    });
  }

  finishAttempt(input: TaskCommand & { worker: WorkerIdentity; next: "waiting" | "validating" | "reconciling" | "failed";
    checkpointRef: string; candidateRef?: string; wait?: WaitCondition; error?: string }): DurableTask {
    return this.#command(input, "attempt.finish", (tx) => {
      const task = requireTask(tx, input.taskId, input.expectedRevision);
      const attempt = requireWorker(tx, task, input.worker);
      const run = requireRun(tx, task.runId);
      text(input.checkpointRef, "checkpoint reference", 1024);
      if (!["waiting", "validating", "reconciling", "failed"].includes(input.next)) throw new Error("Invalid attempt outcome");
      if (input.next === "waiting") validateWait(input.wait);
      else if (input.wait !== undefined) throw new Error("Only waiting outcomes may carry a wait condition");
      if (input.next === "validating") text(input.candidateRef!, "candidate reference", 1024);
      else if (input.candidateRef !== undefined) text(input.candidateRef, "candidate reference", 1024);
      if (input.error !== undefined) text(input.error, "attempt error");
      const previous = task.revision;
      let next: TaskStatus = input.next;
      if (run.status === "cancelling") next = "reconciling"; // Never mistake cancellation for a confirmed effect outcome.
      else if (run.status === "pausing" && input.next !== "failed") {
        next = "paused";
        task.resumeState = input.next === "waiting" ? "waiting" : input.next;
      }
      assertTaskTransition(task.status, next);
      task.status = next; task.revision++; task.updatedAt = tx.now; task.checkpointRef = input.checkpointRef;
      if (input.wait) task.wait = { ...input.wait }; else delete task.wait;
      if (input.candidateRef) task.candidateRef = input.candidateRef;
      if (input.error) task.error = input.error;
      tx.endAttempt(attempt);
      tx.saveTask(task, previous);
      tx.event(run.runId, "attempt.ended", { attemptId: attempt.attemptId, epoch: attempt.epoch, status: next,
        taskRevision: task.revision, checkpointRef: task.checkpointRef, candidateRef: task.candidateRef,
        error: task.error, wait: task.wait, resumeState: task.resumeState }, task.taskId);
      if (task.status === "waiting") wakeWaiting(tx, run);
      else if (task.status === "validating") tx.enqueue({ runId: run.runId, taskId: task.taskId, kind: "wake", key: task.taskId,
        dueAt: tx.now, data: { taskId: task.taskId, revision: task.revision, purpose: "validate" } });
      if (run.status === "pausing" && !tx.activeAttempts(run.runId).length) {
        const revision = run.revision;
        run.status = "paused"; run.revision++; run.updatedAt = tx.now;
        tx.saveRun(run, revision); tx.event(run.runId, "run.paused", { revision: run.revision });
      }
      return tx.getTask(task.taskId)!;
    });
  }

  waitFor(input: TaskCommand & { condition: WaitCondition }): DurableTask {
    return this.#command(input, "task.wait", (tx) => {
      validateWait(input.condition);
      const task = requireTask(tx, input.taskId, input.expectedRevision);
      const run = requireRun(tx, task.runId); requireActive(run, tx.now);
      assertTaskTransition(task.status, "waiting");
      if (task.status !== "ready") throw new Error("Only an idle ready task can register a wait; active attempts must finish first");
      const revision = task.revision;
      task.status = "waiting"; task.wait = { ...input.condition }; task.revision++; task.updatedAt = tx.now;
      tx.saveTask(task, revision);
      tx.event(run.runId, "task.waiting", { condition: task.wait, revision: task.revision }, task.taskId);
      wakeWaiting(tx, run);
      return tx.getTask(task.taskId)!;
    });
  }

  postSignal(input: Command & { runId: string; kind: RuntimeSignal["kind"]; key: string; data: unknown }): RuntimeSignal {
    return this.#command(input, "signal.post", (tx) => {
      const run = requireRun(tx, input.runId);
      validateWait({ kind: input.kind, key: input.key, afterGeneration: 0 });
      const signal = tx.signal(input.runId, input.kind, input.key, input.data);
      tx.event(run.runId, "signal.recorded", { kind: signal.kind, key: signal.key, generation: signal.generation });
      wakeWaiting(tx, run);
      return signal;
    });
  }

  /** Explicit mutation for periodic/startup condition scans. Ordinary reads never wake tasks. */
  scanWaiting(input: Command & { runId: string }): string[] {
    return this.#command(input, "waiting.scan", (tx) => wakeWaiting(tx, requireRun(tx, input.runId)));
  }

  pauseRun(input: RunCommand): DurableRun {
    return this.#command(input, "run.pause", (tx) => {
      const run = requireRun(tx, input.runId, input.expectedRevision);
      if (run.status === "paused" || run.status === "pausing") return run;
      requireActive(run, tx.now, false);
      const previous = run.revision;
      run.status = tx.activeAttempts(run.runId).length ? "pausing" : "paused";
      run.pauseRequestedAt = tx.now; run.revision++; run.updatedAt = tx.now;
      tx.saveRun(run, previous); tx.event(run.runId, `run.${run.status}`, { revision: run.revision });
      control(tx, run, "pause");
      return run;
    });
  }

  resumeRun(input: RunCommand): DurableRun {
    return this.#command(input, "run.resume", (tx) => {
      const run = requireRun(tx, input.runId, input.expectedRevision);
      if (run.status !== "paused" || run.cancelRequestedAt !== undefined) throw new Error("Run cannot resume");
      if (run.deadline !== undefined && run.deadline <= tx.now) throw new Error("Run deadline expired");
      if (tx.activeAttempts(run.runId).length) throw new Error("Run has an undrained attempt");
      const previous = run.revision;
      run.status = "active"; run.revision++; run.updatedAt = tx.now; delete run.pauseRequestedAt;
      tx.saveRun(run, previous); tx.event(run.runId, "run.resumed", { revision: run.revision });
      for (const task of tx.tasks(run.runId)) {
        if (task.status === "paused") {
          const revision = task.revision;
          const next = task.resumeState ?? "ready";
          assertTaskTransition(task.status, next);
          task.status = next; task.revision++; task.updatedAt = tx.now; delete task.resumeState;
          tx.saveTask(task, revision); tx.event(run.runId, "task.resumed", { status: next, revision: task.revision }, task.taskId);
        }
        if (task.status === "ready") schedule(tx, task);
        else if (task.status === "validating") tx.enqueue({ runId: run.runId, taskId: task.taskId, kind: "wake", key: task.taskId,
          dueAt: tx.now, data: { taskId: task.taskId, revision: task.revision, purpose: "validate" } });
      }
      wakeWaiting(tx, run);
      control(tx, run, "resume"); // Supersedes a still-pending pause instead of delivering it after resume.
      return run;
    });
  }

  cancelRun(input: RunCommand): DurableRun {
    return this.#command(input, "run.cancel", (tx) => {
      const run = requireRun(tx, input.runId, input.expectedRevision);
      if (run.status === "cancelling" || run.status === "cancelled") return run;
      if (["succeeded", "failed"].includes(run.status)) throw new Error("Terminal run cannot be cancelled");
      const previous = run.revision;
      run.status = "cancelling"; run.cancelRequestedAt = tx.now; run.revision++; run.updatedAt = tx.now;
      tx.saveRun(run, previous); tx.event(run.runId, "run.cancel_requested", { revision: run.revision });
      refreshWaits(tx, run);
      control(tx, run, "cancel");
      // Cleanup/reconciliation belongs to the worker runtime, so this layer never claims cancellation is complete.
      return run;
    });
  }

  #command<T>(input: Command, kind: string, apply: (tx: RuntimeTransaction) => T): T {
    return this.store.command(input.commandId, { kind, input }, this.clock(), apply);
  }
}

function requireRun(tx: RuntimeTransaction, runId: string, revision?: number): DurableRun {
  const run = tx.getRun(runId);
  if (!run) throw new Error("Durable run not found");
  if (revision !== undefined && integer(revision, "run revision", 1) !== run.revision) throw new Error("Run revision conflict");
  return run;
}
function requireTask(tx: RuntimeTransaction, taskId: string, revision: number): DurableTask {
  const task = tx.getTask(taskId);
  if (!task) throw new Error("Durable task not found");
  if (integer(revision, "task revision", 1) !== task.revision) throw new Error("Task revision conflict");
  return task;
}
function requireActive(run: DurableRun, now: number, checkDeadline = true): void {
  if (run.status !== "active" || run.cancelRequestedAt !== undefined) throw new Error("Run is not active");
  if (checkDeadline && run.deadline !== undefined && run.deadline <= now) throw new Error("Run deadline expired");
}
function requireWorker(tx: RuntimeTransaction, task: DurableTask, worker: WorkerIdentity): DurableAttempt {
  const attempt = tx.getAttempt(worker.attemptId);
  if (!attempt || task.status !== "running" || task.currentAttemptId !== attempt.attemptId || attempt.status !== "active"
    || attempt.ownerId !== worker.ownerId || attempt.epoch !== worker.epoch || task.epoch !== worker.epoch || attempt.leaseExpiresAt <= tx.now) {
    throw new Error("Stale or unauthorized attempt");
  }
  return attempt;
}
function dependenciesSatisfied(tx: RuntimeTransaction, task: DurableTask): boolean {
  return task.dependsOn.every((id) => tx.getTask(id)?.status === "succeeded");
}
function schedule(tx: RuntimeTransaction, task: DurableTask): void {
  tx.enqueue({ runId: task.runId, taskId: task.taskId, kind: "schedule", key: task.taskId,
    dueAt: tx.now, data: { taskId: task.taskId, revision: task.revision } });
}
function control(tx: RuntimeTransaction, run: DurableRun, action: string): void {
  tx.enqueue({ runId: run.runId, kind: "control", key: "run-control", dueAt: tx.now, data: { runId: run.runId, revision: run.revision, action } });
}
export function wakeWaiting(tx: RuntimeTransaction, run: DurableRun): string[] {
  refreshWaits(tx, run);
  if (run.status !== "active" || run.cancelRequestedAt !== undefined || (run.deadline !== undefined && run.deadline <= tx.now)) return [];
  const woken: string[] = [];
  for (const task of tx.tasks(run.runId)) {
    if (task.status !== "waiting" || !dependenciesSatisfied(tx, task)) continue;
    if (task.currentAttemptId && tx.getAttempt(task.currentAttemptId)?.status === "active") continue;
    const signal = task.wait && tx.getSignal(run.runId, task.wait.kind, task.wait.key);
    if (task.wait ? !signal || signal.generation <= task.wait.afterGeneration : !task.dependsOn.length) continue;
    if (task.waitRequestId) {
      const request = tx.record<DurableWait>("wait", task.waitRequestId)?.value;
      if (!request || !["answered", "elapsed", "resolved"].includes(request.state)) continue;
    }
    const previous = task.revision;
    assertTaskTransition(task.status, "ready");
    task.status = "ready"; task.revision++; task.updatedAt = tx.now; delete task.wait;
    tx.saveTask(task, previous);
    tx.event(run.runId, "task.woken", { revision: task.revision, signalGeneration: signal?.generation }, task.taskId);
    schedule(tx, task); woken.push(task.taskId);
  }
  return woken;
}
function validateWait(condition: WaitCondition | undefined): asserts condition is WaitCondition {
  if (!condition || !["message", "approval", "timer", "resource"].includes(condition.kind)) throw new Error("Invalid wait condition");
  text(condition.key, "wait key", 256); integer(condition.afterGeneration, "signal generation");
}
function normalizePolicy(input?: Partial<ExecutionPolicy>): ExecutionPolicy {
  const mode = input?.mode ?? "single";
  if (!["single", "auto", "multi"].includes(mode)) throw new Error("Invalid execution mode");
  const maxActiveAgents = integer(input?.maxActiveAgents ?? 1, "agent capacity", 1, 8);
  const maxDelegationDepth = integer(input?.maxDelegationDepth ?? 0, "delegation depth", 0, 2);
  if (mode === "single" && (maxActiveAgents !== 1 || maxDelegationDepth !== 0)) throw new Error("Single mode cannot grant delegation capacity");
  return { mode, maxActiveAgents, maxDelegationDepth };
}
function validateGraph(definitions: TaskDefinition[]): void {
  if (!Array.isArray(definitions) || definitions.length < 1 || definitions.length > 256) throw new Error("Task graph must contain 1 to 256 tasks");
  const byKey = new Map<string, TaskDefinition>();
  for (const task of definitions) {
    text(task.key, "task key", 128); text(task.objective, "task objective");
    if (!/^[a-f0-9]{64}$/.test(task.inputDigest)) throw new Error("Task input digest must be SHA-256");
    if (byKey.has(task.key)) throw new Error("Duplicate task key");
    if (task.dependsOn !== undefined && (!Array.isArray(task.dependsOn) || new Set(task.dependsOn).size !== task.dependsOn.length)) throw new Error("Invalid dependency list");
    byKey.set(task.key, task);
  }
  const visiting = new Set<string>(); const done = new Set<string>();
  function visit(key: string): void {
    if (visiting.has(key)) throw new Error("Task dependency cycle");
    if (done.has(key)) return;
    const task = byKey.get(key);
    if (!task) throw new Error("Unknown task dependency");
    visiting.add(key);
    for (const dependency of task.dependsOn ?? []) visit(dependency);
    visiting.delete(key); done.add(key);
  }
  for (const key of byKey.keys()) visit(key);
}
