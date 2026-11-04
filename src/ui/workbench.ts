import type { RunDetail, RunPresentation } from "../services/runtime/presentation";
import { displayQuestionText, durableUserQuestion, questionNoticeKey, type InboxQuestion } from "../services/runtime/attention";
import type { TaskRecord } from "../services/tasks/manager";
import type { ShellRuntimeSnapshot } from "../services/shell/manager";
import type { PromptInputSubmit } from "./prompt-input/types";

export type QueuedInput = { id: string; sessionId: string; workspace: string; input: PromptInputSubmit; state: "pending" | "uncertain" | "draft" };
export type WorkbenchTab = "tasks" | "decisions" | "queue";
export type WorkbenchItem = { id: string; title: string; summary: string; lines: string[]; run?: RunPresentation; decision?: InboxQuestion; queued?: QueuedInput; shell?: ShellRuntimeSnapshot };
const clean = (value: string) => displayQuestionText(value);
export function workbenchItems(tab: WorkbenchTab, data: { runs: readonly RunPresentation[]; questions: readonly InboxQuestion[]; queue: readonly QueuedInput[]; tasks: readonly TaskRecord[]; shells: readonly ShellRuntimeSnapshot[] }): WorkbenchItem[] {
  if (tab === "decisions") return data.questions.map((decision) => {
    const question = durableUserQuestion(decision);
    return { id: questionNoticeKey(decision), title: clean(question.header), summary: clean(question.question), decision,
      lines: [question.header, question.question, ...question.options.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` · ${option.description}` : ""}`), "Enter 回答 · Esc 保留问题并返回；回答不增加执行权限"] };
  });
  if (tab === "queue") return data.queue.map((queued) => ({ id: queued.id, title: clean(queued.input.display), summary: queued.state === "uncertain" ? "上次派发未确认，请先核对会话历史" : queued.state === "draft" ? "已取回编辑，原输入仍保存" : "已保存排队，等待当前对话结束", queued,
    lines: [queued.input.display, `会话：${queued.sessionId}`, `工作区：${queued.workspace}`, "E 取回编辑 · D 删除；不会作为补充发给后台任务", ...(queued.state === "uncertain" ? ["上次派发结果未确认，不自动重做；先核对历史，取回编辑不会执行。"] : [])] }));
  return [
    ...data.runs.map((run) => ({ id: `run:${run.runId}`, title: clean(run.title), summary: `${run.mode} · ${run.phase}`, run,
      lines: [`任务：${run.runId}`, `工作区：${run.workspace}`, `模式：${run.mode} · ${run.phase}`, `模型：${run.provider ?? "默认"}/${run.model ?? "默认"}`,
        `后台独立用量：${run.budget.requests}/${run.budget.limit ?? "—"} 请求 · ${run.budget.priced ? `已报告 $${run.budget.reported.toFixed(4)} · 预留 $${run.budget.reserved.toFixed(4)}` : "未配置或未确认计价，不能视为零费用"}`,
        ...run.tasks.map((task) => `${task.parentTaskId ? "  ↳ 只读子任务" : "主任务"}：${task.title} · ${task.phase}`),
        ...run.inputs.map((input) => `补充 r${input.revision} · ${input.state === "delivered" ? "已送达" : "已保存，待安全边界送达"}：${input.text}`),
        "后台能力：单 Agent 编码 / 只读委派；持久 Skill、MCP 尚未接入", `P 暂停 · R 恢复 · X 取消（需确认） · F 补充 · L ${run.reason === "unknown-effects" ? "状态查询" : "调整限制（编辑后提交）"}`] })),
    ...data.tasks.map((task) => ({ id: `agent:${task.id}`, title: clean(task.subject), summary: `Agent / 工作项 · ${task.status}`, lines: [`工作项：${task.id}`, task.subject, `状态：${task.status}`, `负责人：${task.owner ?? "—"}`, "此项沿用原工作项生命周期；长任务控制仅作用于 Run。"] })),
    ...data.shells.map((shell) => ({ id: shell.kind === "pty" ? `pty:${shell.pid}` : `shell:${shell.taskId}`, title: clean(shell.command), summary: shell.kind === "pty" ? `PTY · ${shell.alive ? "运行中" : "已退出"}` : `Shell · ${shell.status}`, shell,
      lines: [shell.command, "此项为 Shell/PTY；K 显式终止，不会取消独立的长任务 Run。"] })),
  ];
}
export function runDetailLines(detail: RunDetail): string[] {
  return [`交付：${detail.acceptance === "domain-verified" ? "场景验收已通过" : detail.acceptance === "verification-commands" ? "配置的验收命令已通过" : detail.acceptance === "report-delivered" ? "报告已交付；没有执行验收命令" : "尚未接纳结果"}`,
    "", "报告", detail.report, "", `检查（${detail.checks.length}）`, ...detail.checks.flatMap((check) => [`✓ ${check.command}`, check.output]),
    "", `已确认的文件修改（最近 ${detail.changes.length} 项）`, ...detail.changes.flatMap((change) => [`${change.tool} · ${change.path}`, change.preview]),
    ...(detail.unresolved.length ? ["", "待核对的操作（不会自动重做）", ...detail.unresolved.flatMap((operation) => [`${operation.name} · operation ${operation.id} · task ${operation.taskId}`, operation.input]),
      `核对真实影响后，在终端使用 tnb runtime reconcile ${detail.run.runId} --task TASK_ID --operation OPERATION_ID --result '实际核对结果'；随后明确恢复。`] : []),
    ...(detail.limitations.length ? ["", "错误 / 遗留项", ...detail.limitations] : [])].map(clean);
}
