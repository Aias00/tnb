import type { DurableRuntime, RuntimeConfiguration } from "./engine-core";

export const NOTICE_EVENTS = ["run.succeeded", "run.failed", "run.blocked", "run.paused", "run.pausing", "run.cancel_requested"] as const;
export type RunNotice = { noticeId: string; runId: string; objective: string; kind: "succeeded" | "failed" | "blocked" | "paused" | "cancelled";
  reason?: string; message: string; at: number };

/** Current actionable/terminal state, with a stable event identity and durable delivery acknowledgment. */
export function pendingRunNotices(runtime: DurableRuntime, workspace: string): RunNotice[] {
  const notices: RunNotice[] = [];
  for (const run of runtime.store.runs()) {
    if (!["succeeded", "failed", "paused", "cancelled"].includes(run.status)) continue;
    if (runtime.store.record<RuntimeConfiguration>("configuration", run.runId)?.value.workspace !== workspace) continue;
    const event = runtime.store.latestEvent(run.runId, NOTICE_EVENTS);
    if (!event || runtime.store.record("attention-ack", event.eventId)) continue;
    const kind = run.status === "paused" ? ((run.pauseReason && run.pauseReason !== "user") || (!run.pauseReason && event.type === "run.blocked") ? "blocked" : "paused") : run.status as "succeeded" | "failed" | "cancelled";
    const description = kind === "succeeded" ? (runtime.configuration(run.runId).domain ? "已完成并通过场景验收。" : runtime.configuration(run.runId).checks?.length ? "已完成并通过配置的验收命令，可用 /task result 查看结果。" : "报告已交付；未执行验收命令，可用 /task result 查看结果。")
      : kind === "failed" ? "执行失败，可用 /task status 查看原因和已有产物。"
      : kind === "cancelled" ? "已取消，停止了后续执行。"
      : kind === "paused" ? "已暂停，恢复前不会继续执行。"
      : run.pauseReason === "budget" ? "预算不足，已暂停。先调整预算上限，再明确恢复；已有用量和预留仍计入。"
      : run.pauseReason === "deadline" ? "已到截止时间，已暂停。先延长截止时间，再明确恢复。"
      : run.pauseReason === "unknown-effects" ? "有操作结果需要核对，已暂停。核对副作用后才能安全继续。"
      : run.pauseReason === "storage" ? "运行状态存储空间不足，已暂停。清理空间后再恢复。"
      : "执行遇到阻塞，已暂停。可用 /task status 查看原因。";
    notices.push({ noticeId: event.eventId, runId: run.runId, objective: run.objective, kind, reason: run.pauseReason,
      message: `长任务「${run.objective.slice(0, 160)}」${description}`, at: event.at });
    if (notices.length === 64) break;
  }
  return notices;
}
