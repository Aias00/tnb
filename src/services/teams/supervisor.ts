import { randomUUID } from "node:crypto";

import type { TaskRecord } from "../tasks/manager";
import type { TeamManager, TeamMember, TeamMessage } from "./manager";

export type TeamResumeSpec = {
  member: TeamMember;
  task: TaskRecord;
  cause: "recovery" | "message";
  message?: TeamMessage;
};

export type TeamSupervisorOptions = {
  recoveryPollIntervalMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  leaseTtlMs?: number;
  leaseHeartbeatMs?: number;
  leaseOwnerId?: string;
};

// Keep the local recovery cadence aligned with the referenced Agent runtime's
// 20-second worker heartbeat. Recovery failures use a shorter bounded backoff
// so a transient launch error does not wait for the next liveness scan.
const DEFAULT_RECOVERY_POLL_INTERVAL_MS = 20_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_LEASE_HEARTBEAT_MS = 20_000;

export class TeamSupervisor {
  private unsubscribe: (() => void) | undefined;
  private active = new Set<string>();
  private failures = new Map<string, { attempts: number; retryAt: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private leaseTimer: ReturnType<typeof setTimeout> | undefined;
  private scan: Promise<void> | undefined;
  private pending = new Set<Promise<void>>();
  private started = false;
  private leaseHeld = false;

  private resume: ((spec: TeamResumeSpec) => Promise<void>) | undefined;
  private readonly recoveryPollIntervalMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly leaseTtlMs: number;
  private readonly leaseHeartbeatMs: number;
  private readonly leaseOwnerId: string;

  constructor(
    private readonly teams: TeamManager,
    private readonly tasks: () => readonly TaskRecord[],
    private readonly onError: (error: Error) => void = () => undefined,
    options: TeamSupervisorOptions = {},
  ) {
    this.recoveryPollIntervalMs = positiveInterval(
      options.recoveryPollIntervalMs,
      DEFAULT_RECOVERY_POLL_INTERVAL_MS,
      "recoveryPollIntervalMs",
    );
    this.retryBaseDelayMs = positiveInterval(
      options.retryBaseDelayMs,
      DEFAULT_RETRY_BASE_DELAY_MS,
      "retryBaseDelayMs",
    );
    this.retryMaxDelayMs = positiveInterval(
      options.retryMaxDelayMs,
      DEFAULT_RETRY_MAX_DELAY_MS,
      "retryMaxDelayMs",
    );
    this.leaseTtlMs = positiveInterval(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS, "leaseTtlMs");
    this.leaseHeartbeatMs = positiveInterval(options.leaseHeartbeatMs, DEFAULT_LEASE_HEARTBEAT_MS, "leaseHeartbeatMs");
    this.leaseOwnerId = options.leaseOwnerId?.trim() || `supervisor-${process.pid}-${randomUUID()}`;
    if (this.retryMaxDelayMs < this.retryBaseDelayMs) {
      throw new Error("retryMaxDelayMs must be greater than or equal to retryBaseDelayMs");
    }
    if (this.leaseHeartbeatMs >= this.leaseTtlMs) throw new Error("leaseHeartbeatMs must be less than leaseTtlMs");
  }

  setResumeHandler(resume: (spec: TeamResumeSpec) => Promise<void>): void {
    this.resume = resume;
    if (this.started) this.runTracked(this.requestRecoveryScan());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.teams.onMessage((message) => this.runTracked(this.resumeRecipients(message)));
    this.runTracked(this.requestRecoveryScan());
    this.scheduleRecoveryScan();
  }

  async recoverAll(): Promise<void> {
    if (!await this.ensureLease()) return;
    const now = Date.now();
    for (const member of this.teams.recoverableMembers()) {
      const failure = this.failures.get(member.agentId);
      const persistedRetryAt = member.recoveryRetryAt ? Date.parse(member.recoveryRetryAt) : 0;
      if ((failure && failure.retryAt > now) || (Number.isFinite(persistedRetryAt) && persistedRetryAt > now)) continue;
      const task = this.findLatestTask(member);
      if (task) {
        const pending = member.status === "idle" ? this.teams.pendingMessages(member.name)[0] : undefined;
        await this.run({ member, task, cause: pending ? "message" : "recovery", ...(pending ? { message: pending } : {}) });
      }
    }
  }

  async close(): Promise<void> {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = undefined;
    await Promise.allSettled([...this.pending]);
    if (this.leaseHeld) await this.teams.releaseLease(this.leaseOwnerId);
    this.leaseHeld = false;
    this.failures.clear();
  }

  private runTracked(operation: Promise<void>): void {
    this.pending.add(operation);
    void operation.catch((error: unknown) => {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => this.pending.delete(operation));
  }

  private async resumeRecipients(message: TeamMessage): Promise<void> {
    if (!await this.ensureLease()) return;
    const state = this.teams.current();
    if (!state) return;
    const recipients = state.members.filter((member) =>
      member.name !== "main" && member.status === "idle" &&
      (message.to === member.name || (message.to === "*" && message.from !== member.name))
    );
    await Promise.all(recipients.map(async (member) => {
      const task = this.findLatestTask(member);
      if (task) await this.run({ member, task, cause: "message", message });
    }));
  }

  private findLatestTask(member: TeamMember): TaskRecord | undefined {
    const tasks = this.tasks();
    const exact = member.runtimeTaskId
      ? tasks.find((task) => task.id === member.runtimeTaskId && task.type === "agent" && task.status !== "running")
      : undefined;
    return exact ?? [...tasks].reverse().find((task) =>
      task.type === "agent" && task.status !== "running" && task.metadata?.agentId === member.agentId
    );
  }

  private async run(spec: TeamResumeSpec): Promise<void> {
    if (this.active.has(spec.member.agentId) || !this.resume) return;
    this.active.add(spec.member.agentId);
    try {
      await this.resume(spec);
      this.failures.delete(spec.member.agentId);
      await this.teams.clearRecoveryFailure(this.teams.current()!.name, spec.member.agentId);
    } catch (error) {
      const failure = this.failures.get(spec.member.agentId);
      const attempts = Math.max(failure?.attempts ?? 0, spec.member.recoveryAttempts ?? 0) + 1;
      const delay = Math.min(this.retryBaseDelayMs * (2 ** Math.min(attempts - 1, 30)), this.retryMaxDelayMs);
      const normalized = error instanceof Error ? error : new Error(String(error));
      const retryAt = Date.now() + delay;
      this.failures.set(spec.member.agentId, { attempts, retryAt });
      await this.teams.recordRecoveryFailure(this.teams.current()!.name, spec.member.agentId, attempts, retryAt, normalized.message);
      this.onError(normalized);
      this.scheduleRecoveryScan(delay, true);
    } finally {
      this.active.delete(spec.member.agentId);
    }
  }

  private requestRecoveryScan(): Promise<void> {
    if (this.scan) return this.scan;
    this.scan = this.recoverAll().finally(() => {
      this.scan = undefined;
    });
    return this.scan;
  }

  private scheduleRecoveryScan(delay = this.recoveryPollIntervalMs, replace = false): void {
    if (!this.started) return;
    if (replace && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.started) return;
      this.runTracked(this.requestRecoveryScan().finally(() => this.scheduleRecoveryScan()));
    }, delay);
    this.timer.unref?.();
  }

  private async ensureLease(): Promise<boolean> {
    if (this.leaseHeld) return true;
    this.leaseHeld = await this.teams.acquireLease(this.leaseOwnerId, this.leaseTtlMs);
    if (this.leaseHeld) this.scheduleLeaseHeartbeat();
    return this.leaseHeld;
  }

  private scheduleLeaseHeartbeat(): void {
    if (!this.started || this.leaseTimer) return;
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = undefined;
      if (!this.started || !this.leaseHeld) return;
      this.runTracked(this.teams.renewLease(this.leaseOwnerId, this.leaseTtlMs).then((renewed) => {
        this.leaseHeld = renewed;
        if (renewed) this.scheduleLeaseHeartbeat();
      }));
    }, this.leaseHeartbeatMs);
    this.leaseTimer.unref?.();
  }
}

function positiveInterval(value: number | undefined, fallback: number, name: string): number {
  const interval = value ?? fallback;
  if (!Number.isSafeInteger(interval) || interval <= 0) throw new Error(`${name} must be a positive integer`);
  return interval;
}
