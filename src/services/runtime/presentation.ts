import type { DurableRuntime } from "./engine-core";
import type { DurableTask, RunStatus } from "./types";
import type { TaskActivity } from "./activity";
import type { TaskInput } from "./routing";
import type { DurableWait } from "./waits";
import type { Operation } from "./journal";
import type { TaskProgress } from "./progress";

export type RunPresentation = {
  runId: string; revision: number; title: string; workspace: string; mode: string; status: RunStatus; phase: string; reason?: string;
  updatedAt: number; model?: string; provider?: string; checks: number;
  budget: { reported: number; reserved: number; requests: number; limit?: number; maxCostUsd?: number; priced: boolean };
  tasks: Array<{ taskId: string; parentTaskId?: string; title: string; status: string; phase: string }>;
  inputs: Array<{ inputId: string; text: string; state: string; revision: number }>;
};
export type RunDetail = { run: RunPresentation; report: string; acceptance: string; checks: Array<{ command: string; output: string }>;
  changes: Array<{ path: string; taskId: string; tool: string; preview: string }>; limitations: string[];
  unresolved: Array<{ id: string; taskId: string; name: string; input: string }> };
export const pauseDescription: Record<string, string> = {
  user: "用户暂停", budget: "请求数或费用额度不足", deadline: "已到截止时间", storage: "状态存储空间不足",
  "unknown-effects": "操作结果未知，需要核对影响", "execution-error": "执行阻塞，需要查看错误",
};
const phaseLabels: Record<TaskActivity["phase"], string> = { preparing: "准备模型请求 / 等待模型名额", model: "请求模型", compacting: "整理上下文",
  workspace: "等待工作区释放", resources: "等待业务资源释放", capacity: "等待执行名额", verification: "正在验收" };
function taskPhase(runtime: DurableRuntime, task: DurableTask): string {
  if (task.status === "succeeded") return "已接纳结果";
  if (task.status === "failed") return "失败";
  if (task.status === "cancelled") return "已取消";
  if (task.status === "paused") return "已暂停";
  if (task.status === "waiting") {
    const wait = task.waitRequestId && runtime.store.record<DurableWait>("wait", task.waitRequestId)?.value;
    return wait && wait.proposal.kind === "question" ? "等待用户回答" : wait && wait.proposal.kind === "children" ? "等待子任务" : wait && wait.proposal.kind === "timer" ? "等待定时唤醒" : "等待依赖";
  }
  if (task.status === "reconciling") return "核对恢复状态";
  const activity = runtime.store.record<TaskActivity>("task-activity", task.taskId)?.value;
  if (task.status === "validating" && activity?.phase !== "verification") return "准备验收";
  const pending = runtime.store.record<TaskProgress>("task-progress", task.taskId)?.value.pending;
  if (task.status === "running" && pending?.length && activity?.phase !== "compacting") return `执行工具：${pending.slice(0, 3).map((call) => call.name).join("、")}`;
  if (activity && (task.status === "running" || task.status === "validating" || ["workspace", "resources", "capacity"].includes(activity.phase))) {
    return activity.phase === "verification" ? `验收 ${activity.completed ?? 0}/${activity.total ?? 0}` : phaseLabels[activity.phase];
  }
  return task.status === "validating" ? "待验收" : "待执行";
}
export function presentRun(runtime: DurableRuntime, runId: string): RunPresentation {
  const run = runtime.store.getRun(runId)!; const config = runtime.configuration(runId); const tasks = runtime.store.tasks(runId);
  const root = tasks.find((task) => !task.parentTaskId);
  const charges = runtime.store.records<{ priced?: boolean }>("model-request", runId); const requests = charges.length;
  const inputs = root ? runtime.store.records<TaskInput>("task-input", runId, root.taskId).sort((a, b) => b.value.inputRevision - a.value.inputRevision).slice(0, 3) : [];
  const phase = run.status === "paused" ? pauseDescription[run.pauseReason ?? "user"] ?? "已暂停" : run.status === "pausing" ? "暂停中，正在排空执行" : run.status === "cancelling" ? "取消中，正在核对执行结果"
    : run.status === "succeeded" ? (config.domain ? "场景验收通过" : config.checks?.length ? "验收通过" : "报告已交付，未执行验收命令") : run.status === "failed" ? "任务失败" : run.status === "cancelled" ? "已取消" : root ? taskPhase(runtime, root) : "待执行";
  return { runId, revision: run.revision, title: run.objective.slice(0, 160), workspace: config.workspace, mode: run.policy.mode, status: run.status, phase,
    reason: run.pauseReason, updatedAt: Math.max(run.updatedAt, ...tasks.map((task) => Math.max(task.updatedAt, runtime.store.record<TaskActivity>("task-activity", task.taskId)?.value.at ?? 0))), model: config.model?.slice(0, 256), provider: config.provider?.slice(0, 256), checks: config.checks?.length ?? 0,
    budget: { ...runtime.budget.totals(runId), requests, limit: config.maxModelRequests, maxCostUsd: config.maxCostUsd, priced: requests > 0 && charges.every((charge) => charge.value.priced === true) },
    tasks: tasks.map((task) => ({ taskId: task.taskId, parentTaskId: task.parentTaskId, title: task.objective.slice(0, 96), status: task.status, phase: taskPhase(runtime, task) })),
    inputs: inputs.map(({ value }) => ({ inputId: value.inputId, text: value.text.slice(0, 128), state: value.state, revision: value.inputRevision })) };
}
export function presentRuns(runtime: DurableRuntime, workspace: string): RunPresentation[] {
  return runtime.store.runs().filter((run) => runtime.store.record<{ workspace: string }>("configuration", run.runId)?.value.workspace === workspace)
    .sort((a, b) => Number(["succeeded", "failed", "cancelled"].includes(a.status)) - Number(["succeeded", "failed", "cancelled"].includes(b.status)) || b.createdAt - a.createdAt)
    .slice(0, 32).map((run) => presentRun(runtime, run.runId));
}
export async function presentRunDetail(runtime: DurableRuntime, runId: string): Promise<RunDetail> {
  const run = presentRun(runtime, runId); const tasks = runtime.store.tasks(runId); const root = tasks.find((task) => !task.parentTaskId);
  const result = root?.resultRef ? await runtime.artifacts.get<{ report: string; acceptance: string; checks: Array<{ command: string; output: string }> }>(root.resultRef) : undefined;
  const operations = runtime.store.records<Operation>("operation", runId);
  const changes = operations.filter(({ value }) => ["write", "edit"].includes(value.call.name) && value.state === "settled" && value.outcome?.result.isError === false).slice(-40).map((record) => {
    const input = record.value.call.input as Record<string, unknown>;
    const old = input.oldText ?? input.old_string, next = input.newText ?? input.new_string;
    return { path: String(input.path ?? input.file_path ?? "unknown"), taskId: record.taskId!, tool: record.value.call.name,
      preview: record.value.call.name === "edit" ? `- ${String(old ?? "").slice(0, 4000)}\n+ ${String(next ?? "").slice(0, 4000)}` : String(input.content ?? record.value.outcome?.result.content ?? "").slice(0, 8000) };
  });
  return { run, report: result?.report ?? "尚无已接纳的最终报告", acceptance: result?.acceptance ?? "pending", checks: result?.checks ?? [], changes,
    unresolved: operations.filter(({ value }) => value.state === "dispatched" || value.effectOutcome === "unknown").slice(0, 16).map((record) => ({ id: record.id, taskId: record.taskId!, name: record.value.call.name, input: JSON.stringify(record.value.call.input).slice(0, 16000) })),
    limitations: tasks.filter((task) => task.error).map((task) => `${task.objective.slice(0, 80)}: ${task.error?.slice(0, 2000)}`).slice(0, 16) };
}
