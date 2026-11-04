import { digestJson, integer, text } from "./json";
import type { RuntimeStore, RuntimeTransaction } from "./store";
import type { RuntimeConfiguration } from "./engine";

export type RoutingInput = { inputId: string; workspace: string; rawText: string; source: "cli" | "conversation" | "api"; sessionId?: string; resolutionRevision?: number };
export type RoutingDecision = RoutingInput & {
  action: string; status: "accepted" | "clarify" | "rejected"; reason: string; revision: number; policyRevision: 1;
  runId?: string; taskId?: string; candidates: Array<{ runId: string; objective: string; status: string }>; at: number;
};
export type TaskInput = { inputId: string; text: string; inputRevision: number; state: "pending" | "delivered"; at: number };

export function validateRoutingInput(input: RoutingInput): void {
  text(input.inputId, "source input ID", 128); text(input.workspace, "input workspace", 4096); text(input.rawText, "original input", 16384);
  if (!["cli", "conversation", "api"].includes(input.source)) throw new Error("Invalid input source");
  if (input.sessionId !== undefined) text(input.sessionId, "input session", 128);
  if (input.resolutionRevision !== undefined) integer(input.resolutionRevision, "routing resolution revision", 1);
}
export function recordRouting(tx: RuntimeTransaction, input: RoutingInput, action: string, runId: string, taskId?: string): void {
  validateRoutingInput(input);
  const previous = tx.route<RoutingDecision>(input.inputId);
  if (previous?.status === "clarify" && previous.action === action && previous.workspace === input.workspace && previous.sessionId === input.sessionId && previous.rawText === input.rawText
    && previous.revision === input.resolutionRevision && previous.candidates.some((candidate) => candidate.runId === runId)) {
    const decision: RoutingDecision = { ...previous, status: "accepted", reason: "explicit-target-selection", runId, taskId, revision: previous.revision + 1, at: tx.now };
    tx.saveRoute(input.inputId, input.workspace, decision); tx.event(runId, "input.routed", { inputId: input.inputId, action, policyRevision: 1 }, taskId); return;
  }
  if (previous && (previous.workspace !== input.workspace || previous.sessionId !== input.sessionId || previous.rawText !== input.rawText || previous.action !== action || previous.runId !== runId)) throw new Error("Input identity already routed differently");
  if (previous) return;
  const decision: RoutingDecision = { ...input, action, runId, taskId, status: "accepted", reason: "explicit-command", revision: 1, policyRevision: 1, candidates: [], at: tx.now };
  tx.saveRoute(input.inputId, input.workspace, decision);
  tx.event(runId, "input.routed", { inputId: input.inputId, action, taskId, policyRevision: 1 }, taskId);
}

/** Route original follow-ups; no model, file operation or permission expansion occurs here. */
export class TaskRouter {
  constructor(readonly store: RuntimeStore, private readonly clock: () => number = Date.now) {}
  clarifyControl(input: { commandId: string; source: RoutingInput; action: string }): RoutingDecision {
    validateRoutingInput(input.source);
    if (!["pause", "cancel", "resume"].includes(input.action)) throw new Error("Control needs an explicit target");
    return this.store.command(input.commandId, { kind: "input.control-clarify", ...input }, this.clock(), (tx) => {
      const previous = tx.route<RoutingDecision>(input.source.inputId);
      if (previous) {
        if (previous.rawText !== input.source.rawText || previous.workspace !== input.source.workspace || previous.sessionId !== input.source.sessionId || previous.action !== `run.${input.action}`) throw new Error("Input identity conflict");
        return previous;
      }
      const candidates = this.store.runs().filter((run) => tx.record<RuntimeConfiguration>("configuration", run.runId)?.value.workspace === input.source.workspace
        && !["succeeded", "failed", "cancelled"].includes(run.status));
      const decision: RoutingDecision = { ...input.source, action: `run.${input.action}`, status: "clarify", reason: "select-control-target",
        revision: 1, policyRevision: 1, candidates: candidates.slice(0, 64).map(({ runId, objective, status }) => ({ runId, objective: objective.slice(0, 256), status })), at: tx.now };
      tx.saveRoute(decision.inputId, decision.workspace, decision); return decision;
    });
  }
  followup(input: { commandId: string; source: RoutingInput; runId?: string; taskId?: string; resolveInputId?: string; expectedRevision?: number }): RoutingDecision {
    validateRoutingInput(input.source);
    return this.store.command(input.commandId, { kind: "input.route", ...input }, this.clock(), (tx) => {
      let source = input.source;
      let previous: RoutingDecision | undefined;
      if (input.resolveInputId) {
        previous = tx.route<RoutingDecision>(input.resolveInputId);
        if (!previous || previous.workspace !== source.workspace || previous.sessionId !== source.sessionId) throw new Error("Routing question not found in this conversation");
        if (previous.status !== "clarify") throw new Error("Routing question is already decided");
        if (input.expectedRevision !== previous.revision || !input.runId) throw new Error("Resolution needs a target and current routing revision");
        if (previous.action !== "followup" || !previous.candidates.some((candidate) => candidate.runId === input.runId)) throw new Error("Routing target is not in the original question scope");
        source = { inputId: previous.inputId, workspace: previous.workspace, rawText: previous.rawText, source: previous.source, sessionId: previous.sessionId };
      } else {
        previous = tx.route<RoutingDecision>(source.inputId);
        if (previous) {
          if (previous.rawText !== source.rawText || previous.workspace !== source.workspace || previous.sessionId !== source.sessionId || previous.action !== "followup"
            || (input.runId && previous.runId !== input.runId)) throw new Error("Input identity conflict; resolve recorded clarification explicitly");
          return previous;
        }
      }
      const candidates = this.store.runs().filter((run) => tx.record<RuntimeConfiguration>("configuration", run.runId)?.value.workspace === source.workspace);
      const eligible = candidates.filter((run) => ["active", "paused", "pausing"].includes(run.status));
      const own = source.sessionId ? eligible.filter((run) => tx.record<RuntimeConfiguration>("configuration", run.runId)?.value.originSessionId === source.sessionId) : eligible;
      const choices = own.length ? own : eligible;
      const target = input.runId ? candidates.find((run) => run.runId === input.runId) : choices.length === 1 ? choices[0] : undefined;
      const decision: RoutingDecision = { ...source, action: "followup", status: "clarify", reason: "ambiguous-target",
        revision: (previous?.revision ?? 0) + 1, policyRevision: 1, candidates: choices.slice(0, 64).map(({ runId, objective, status }) => ({ runId, objective: objective.slice(0, 256), status })), at: tx.now };
      if (input.runId && !target) { decision.status = "rejected"; decision.reason = "target-outside-workspace"; }
      else if (target) {
        decision.runId = target.runId;
        if (!["active", "paused", "pausing"].includes(target.status)) { decision.status = "rejected"; decision.reason = "terminal-requires-explicit-successor"; }
        else if (target.deadline !== undefined && target.deadline <= tx.now) { decision.status = "rejected"; decision.reason = "deadline-expired"; }
        else {
          const task = input.taskId ? tx.getTask(input.taskId) : tx.tasks(target.runId).find((task) => !task.parentTaskId);
          if (!task || task.runId !== target.runId || ["succeeded", "failed", "cancelled"].includes(task.status)) {
            decision.status = "rejected"; decision.reason = "task-requires-explicit-successor";
          } else {
            if (tx.records("task-input", target.runId, task.taskId).length >= 256) throw new Error("Task input capacity reached");
            const revision = integer((task.inputRevision ?? 0) + 1, "task input revision", 1);
            const value: TaskInput = { inputId: source.inputId, text: source.rawText, inputRevision: revision, state: "pending", at: tx.now };
            tx.saveRecord({ kind: "task-input", id: digestJson({ taskId: task.taskId, inputId: source.inputId }), runId: target.runId, taskId: task.taskId, value }, 0);
            tx.saveTask({ ...task, inputRevision: revision, revision: task.revision + 1, updatedAt: tx.now }, task.revision);
            decision.status = "accepted"; decision.reason = "bound-existing-task"; decision.taskId = task.taskId;
            tx.event(target.runId, "input.queued", { inputId: source.inputId, inputRevision: revision }, task.taskId);
            tx.enqueue({ runId: target.runId, taskId: task.taskId, kind: "wake", key: `input:${source.inputId}`, dueAt: tx.now, data: { purpose: "input" } });
          }
        }
      } else if (!choices.length) decision.reason = "no-target";
      tx.saveRoute(source.inputId, source.workspace, decision);
      return decision;
    });
  }
}

export class TaskInputChanged extends Error {}
