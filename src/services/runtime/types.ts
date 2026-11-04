/** Persistent business state. This module never launches a model or tool. */
export type RunStatus = "active" | "pausing" | "paused" | "cancelling" | "cancelled" | "succeeded" | "failed";
export type TaskStatus = "pending" | "ready" | "running" | "waiting" | "reconciling" | "validating" | "paused" | "succeeded" | "failed" | "cancelled";
export type WaitCondition = { kind: "message" | "approval" | "timer" | "resource"; key: string; afterGeneration: number };
export type ExecutionPolicy = { mode: "single" | "auto" | "multi"; maxActiveAgents: number; maxDelegationDepth: number };
export type PauseReason = "user" | "deadline" | "storage" | "budget" | "unknown-effects" | "execution-error";
export type RunLimits = { maxCostUsd?: number };

export type DurableRun = {
  runId: string;
  objective: string;
  revision: number;
  status: RunStatus;
  policy: ExecutionPolicy;
  createdAt: number;
  updatedAt: number;
  deadline?: number;
  pauseRequestedAt?: number;
  pauseReason?: PauseReason;
  cancelRequestedAt?: number;
};

export type DurableTask = {
  taskId: string;
  runId: string;
  key: string;
  objective: string;
  inputDigest: string;
  dependsOn: string[];
  revision: number;
  status: TaskStatus;
  epoch: number;
  currentAttemptId?: string;
  parentTaskId?: string;
  wait?: WaitCondition;
  waitRequestId?: string;
  resumeState?: "ready" | "waiting" | "validating" | "reconciling";
  checkpointRef?: string;
  candidateRef?: string;
  resultRef?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

export type DurableAttempt = {
  attemptId: string;
  taskId: string;
  ownerId: string;
  epoch: number;
  leaseExpiresAt: number;
  status: "active" | "ended";
  createdAt: number;
  endedAt?: number;
  suspended?: boolean;
};
export type RuntimeRecord<T = unknown> = { kind: string; id: string; runId: string; taskId?: string; revision: number; value: T };

export type WorkerIdentity = { attemptId: string; ownerId: string; epoch: number };
export type RuntimeEvent = { eventId: string; runId: string; sequence: number; commandId: string; type: string; taskId?: string; at: number; data: unknown };
export type RuntimeSignal = { runId: string; kind: WaitCondition["kind"]; key: string; generation: number; data: unknown; at: number };
export type RuntimeEffect = {
  effectId: string;
  runId: string;
  taskId?: string;
  kind: "schedule" | "wake" | "control";
  key: string;
  sequence: number;
  generation: number;
  attempts: number;
  dueAt: number;
  data: unknown;
  leaseToken?: string;
  leaseOwner?: string;
  leaseGeneration?: number;
  leaseExpiresAt?: number;
};

export const TERMINAL_TASK_STATES = new Set<TaskStatus>(["succeeded", "failed", "cancelled"]);
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["ready", "waiting", "paused", "cancelled"],
  ready: ["running", "waiting", "paused", "cancelled"],
  running: ["waiting", "reconciling", "validating", "paused", "failed"],
  waiting: ["ready", "running", "validating", "paused", "cancelled", "reconciling"],
  reconciling: ["ready", "validating", "waiting", "paused", "failed", "cancelled"],
  validating: ["succeeded", "ready", "failed", "paused", "reconciling"],
  paused: ["ready", "waiting", "validating", "reconciling", "cancelled"],
  succeeded: [], failed: [], cancelled: [],
};

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TRANSITIONS[from]?.includes(to)) throw new Error(`Invalid durable task transition: ${from} -> ${to}`);
}
