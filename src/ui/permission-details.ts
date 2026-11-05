import type { PermissionAskRequest } from "../core/permissions";
import { displayQuestionText } from "../services/runtime/attention";

export function permissionDetails(request: PermissionAskRequest): string[] {
  const input = request.input && typeof request.input === "object" ? request.input as Record<string, unknown> : {};
  const lines = [request.message, `工具：${request.tool.name}`, `操作类型：${request.tool.risk}`];
  if (request.tool.name === "bash") lines.push("完整命令", String(input.command ?? ""), `工作目录：${input.cwd ?? "当前授权工作区"}`);
  else if (["write", "edit"].includes(request.tool.name)) {
    lines.push(`文件：${input.path ?? input.file_path ?? "—"}`);
    if (request.tool.name === "edit") lines.push("将替换", String(input.oldText ?? input.old_string ?? ""), "替换为", String(input.newText ?? input.new_string ?? ""));
    else lines.push("写入内容", String(input.content ?? ""));
  } else if (request.tool.name === "exit_plan_mode" && typeof input.plan === "string") lines.push("计划审阅", input.plan);
  else lines.push("完整参数", JSON.stringify(request.input, null, 2));
  if (request.suggestedRule) lines.push(`可保存规则：${request.suggestedRule}`, "单次：只允许本次操作；会话：本会话匹配规则；项目：保存匹配规则。");
  return lines.map(displayQuestionText);
}
