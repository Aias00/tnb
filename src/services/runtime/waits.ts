import { randomUUID } from "node:crypto";
import { digestJson, integer, text } from "./json";
import { RuntimeStore, type RuntimeTransaction } from "./store";
import type { DurableRun, DurableTask, WorkerIdentity } from "./types";

export type WaitProposal =
  | { kind: "question"; key: string; question: string; options?: string[]; about: string }
  | { kind: "timer"; key: string; at: string; about: string }
  | { kind: "children"; key: string; children: string[]; about: string };
export type DurableWait = {
  waitId: string; runId: string; taskId: string; proposal: WaitProposal; digest: string;
  state: "open" | "answered" | "elapsed" | "resolved" | "cancelled";
  createdAt: number; dueAt?: number; answer?: string; answeredVersion?: number;
  completedAt?: number; consumedAt?: number;
};
export type WaitView = DurableWait & { version: number };

/** Runtime-owned waits do not grant filesystem, Shell or approval authority. */
export class DurableWaits {
  constructor(readonly store: RuntimeStore, private readonly clock: () => number = Date.now) {}
  current(taskId: string): DurableWait | undefined {
    const id = this.store.getTask(taskId)?.waitRequestId;
    return id ? this.store.record<DurableWait>("wait", id)?.value : undefined;
  }
  pending(runId: string): WaitView[] {
    return this.store.records<DurableWait>("wait", runId)
      .filter((record) => !record.value.consumedAt && record.value.state !== "cancelled" && this.store.getTask(record.value.taskId)?.waitRequestId === record.id)
      .map((record) => ({ ...record.value, version: record.revision }));
  }
  questions(runId: string): WaitView[] {
    const run = this.store.getRun(runId);
    if (!run || !["active", "paused", "pausing"].includes(run.status) || (run.deadline !== undefined && run.deadline <= this.clock())) return [];
    return this.store.records<DurableWait>("wait", runId)
      .filter((record) => record.value.proposal.kind === "question" && record.value.state === "open")
      .map((record) => ({ ...record.value, version: record.revision }));
  }
  request(taskId: string, worker: WorkerIdentity, proposal: WaitProposal): DurableWait {
    validateWaitProposal(proposal);
    const waitId = digestJson({ taskId, key: proposal.key });
    const digest = digestJson(proposal);
    return this.store.command(randomUUID(), { kind: "wait.request", taskId, worker, proposal }, this.clock(), (tx) => {
      const task = requireLiveTask(tx, taskId, worker);
      const previous = tx.record<DurableWait>("wait", waitId);
      if (previous) {
        if (previous.value.digest !== digest) throw new Error("Wait key has conflicting input; use a new key for a new question or review");
        return previous.value;
      }
      if (task.waitRequestId) throw new Error("This task already has an outstanding wait");
      if (tx.records("wait", task.runId, taskId).length >= 256) throw new Error("Task wait limit exceeded");
      if (tx.records("wait", task.runId).length >= 4096) throw new Error("Run wait limit exceeded");
      const run = tx.getRun(task.runId)!;
      const dueAt = proposal.kind === "timer" ? Date.parse(proposal.at) : undefined;
      if (dueAt !== undefined && (dueAt <= tx.now || (run.deadline !== undefined && dueAt >= run.deadline))) throw new Error("Timer must be in the future and before the Run deadline");
      if (proposal.kind === "children" && proposal.children.some((id) => tx.getTask(id)?.parentTaskId !== taskId)) throw new Error("Wait children must belong to this parent");
      const value: DurableWait = { waitId, runId: task.runId, taskId, proposal: structuredClone(proposal), digest, state: "open", createdAt: tx.now,
        ...(dueAt !== undefined ? { dueAt } : {}) };
      tx.saveRecord({ kind: "wait", id: waitId, runId: task.runId, taskId, value }, 0);
      tx.saveTask({ ...task, waitRequestId: waitId, revision: task.revision + 1, updatedAt: tx.now }, task.revision);
      tx.event(task.runId, "wait.requested", { waitId, kind: proposal.kind, key: proposal.key }, taskId);
      if (dueAt !== undefined) tx.enqueue({ runId: task.runId, taskId, kind: "wake", key: `wait:${waitId}`, dueAt, data: { purpose: "wait", waitId } });
      return value;
    });
  }
  answer(input: { commandId: string; runId: string; waitId: string; expectedVersion: number; answer: string }): WaitView {
    text(input.answer, "question answer", 8000); integer(input.expectedVersion, "question version", 1);
    return this.store.command(input.commandId, { kind: "wait.answer", input }, this.clock(), (tx) => {
      const record = tx.record<DurableWait>("wait", input.waitId);
      if (!record || record.runId !== input.runId || record.value.proposal.kind !== "question") throw new Error("Question not found in this Run");
      const value = record.value;
      if (value.state === "answered") {
        if (value.answer !== input.answer || value.answeredVersion !== input.expectedVersion) throw new Error("Question already answered with different input");
        return { ...value, version: record.revision };
      }
      const run = tx.getRun(input.runId)!;
      if (value.state !== "open" || !["active", "paused", "pausing"].includes(run.status)
        || run.cancelRequestedAt !== undefined || (run.deadline !== undefined && run.deadline <= tx.now)) throw new Error("Question is no longer accepting answers");
      if (record.revision !== input.expectedVersion) throw new Error("Question version conflict; read the current question before answering");
      const answered: DurableWait = { ...value, state: "answered", answer: input.answer, answeredVersion: input.expectedVersion, completedAt: tx.now };
      const saved = tx.saveRecord({ ...record, value: answered }, record.revision);
      tx.signal(input.runId, "message", input.waitId, { waitId: input.waitId });
      tx.event(input.runId, "wait.answered", { waitId: input.waitId, version: saved.revision }, value.taskId);
      // Waking is performed by the owner's next scan, including answers that precede parking.
      return { ...answered, version: saved.revision };
    });
  }
  consume(taskId: string, worker: WorkerIdentity, waitId: string): void {
    this.store.command(randomUUID(), { kind: "wait.consume", taskId, worker, waitId }, this.clock(), (tx) => {
      const task = requireLiveTask(tx, taskId, worker);
      const record = tx.record<DurableWait>("wait", waitId);
      if (!record || task.waitRequestId !== waitId || !["answered", "elapsed", "resolved"].includes(record.value.state)) throw new Error("Wait is not ready to resume");
      tx.saveRecord({ ...record, value: { ...record.value, consumedAt: tx.now } }, record.revision);
      const next = { ...task, revision: task.revision + 1, updatedAt: tx.now }; delete next.waitRequestId;
      tx.saveTask(next, task.revision);
      tx.event(task.runId, "wait.resumed", { waitId }, taskId); return true;
    });
  }
}

/** Called inside the same transaction that wakes tasks or settles Run control. */
export function refreshWaits(tx: RuntimeTransaction, run: DurableRun): void {
  for (const record of tx.records<DurableWait>("wait", run.runId)) {
    const wait = record.value;
    if (wait.state !== "open") continue;
    let state: DurableWait["state"] | undefined;
    if (["cancelling", "cancelled", "failed", "succeeded"].includes(run.status)) state = "cancelled";
    else if (run.status === "active") {
      if (wait.proposal.kind === "timer" && wait.dueAt! <= tx.now) state = "elapsed";
      if (wait.proposal.kind === "children" && wait.proposal.children.every((id) => tx.getTask(id)?.status === "succeeded")) state = "resolved";
    }
    if (!state) continue;
    tx.saveRecord({ ...record, value: { ...wait, state, completedAt: tx.now } }, record.revision);
    tx.event(run.runId, `wait.${state}`, { waitId: wait.waitId }, wait.taskId);
    if (state !== "cancelled") tx.signal(run.runId, wait.proposal.kind === "timer" ? "timer" : "resource", wait.waitId, { waitId: wait.waitId });
  }
}

export function validateWaitProposal(value: unknown): asserts value is WaitProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid durable wait");
  const input = value as WaitProposal;
  text(input.key, "wait key", 128); text(input.about, "resumption context", 8000);
  const fields = input.kind === "question" ? ["kind", "key", "about", "question", "options"]
    : input.kind === "timer" ? ["kind", "key", "about", "at"] : input.kind === "children" ? ["kind", "key", "about", "children"] : [];
  if (!fields.length || Object.keys(input).some((key) => !fields.includes(key))) throw new Error("Unsupported durable wait capability");
  if (input.kind === "question") {
    text(input.question, "question", 4000);
    if (input.options !== undefined) {
      if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 8) throw new Error("Question requires two to eight options");
      input.options.forEach((option) => text(option, "question option", 1000));
    }
  } else if (input.kind === "timer") {
    text(input.at, "timer date", 64);
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.at) || !Number.isSafeInteger(Date.parse(input.at))) throw new Error("Timer requires an ISO date with a timezone");
  } else if (!Array.isArray(input.children) || input.children.length < 1 || input.children.length > 4 || input.children.some((id) => typeof id !== "string" || !id)) throw new Error("Invalid child wait");
}

function requireLiveTask(tx: RuntimeTransaction, taskId: string, worker: WorkerIdentity): DurableTask {
  const task = tx.getTask(taskId), attempt = tx.getAttempt(worker.attemptId);
  const run = task && tx.getRun(task.runId);
  if (!task || task.status !== "running" || task.currentAttemptId !== worker.attemptId || task.epoch !== worker.epoch
    || attempt?.status !== "active" || attempt.ownerId !== worker.ownerId || attempt.epoch !== worker.epoch || attempt.leaseExpiresAt <= tx.now
    || run?.status !== "active" || run.cancelRequestedAt !== undefined || (run.deadline !== undefined && run.deadline <= tx.now)) throw new Error("Stale or unauthorized wait request");
  return task;
}
