import { randomUUID } from "node:crypto";
import type { RuntimeStore } from "./store";
import type { DurableTask } from "./types";

export type TaskActivity = { phase: "preparing" | "model" | "compacting" | "workspace" | "capacity" | "verification";
  at: number; completed?: number; total?: number };

/** A durable display projection; never an execution or permission decision. */
export function recordActivity(store: RuntimeStore, task: DurableTask, phase: TaskActivity["phase"], counts?: { completed: number; total: number }): void {
  const previous = store.record<TaskActivity>("task-activity", task.taskId);
  if (previous?.value.phase === phase && previous.value.completed === counts?.completed && previous.value.total === counts?.total) return;
  store.command(randomUUID(), { kind: "activity.update", taskId: task.taskId, phase, counts }, Date.now(), (tx) => {
    if (tx.getRun(task.runId)?.status !== "active") return false;
    const old = tx.record<TaskActivity>("task-activity", task.taskId);
    tx.saveRecord({ kind: "task-activity", id: task.taskId, runId: task.runId, taskId: task.taskId, value: { phase, at: tx.now, ...counts } }, old?.revision ?? 0);
    tx.event(task.runId, "activity.changed", { phase, ...counts }, task.taskId); return true;
  });
}
