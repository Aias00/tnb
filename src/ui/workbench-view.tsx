import React from "react";
import { Box, Text } from "./ink/index";
import wrapAnsi from "wrap-ansi";
import { displayQuestionText } from "../services/runtime/attention";
import type { WorkbenchItem, WorkbenchTab } from "./workbench";

export function WorkbenchView({ tab, items, selection, detail, offset, height, width, error, busy, confirming }: {
  tab: WorkbenchTab; items: WorkbenchItem[]; selection: number; detail?: string[]; offset: number; height: number; width: number;
  error?: string; busy?: boolean; confirming?: string;
}) {
  const selected = items[Math.min(selection, Math.max(0, items.length - 1))];
  const title = `任务工作台 · ${tab === "tasks" ? "任务" : tab === "decisions" ? "待决定" : "排队输入"}`;
  const rows = Math.max(1, height - 7);
  const lines = detail?.flatMap((line) => wrapAnsi(displayQuestionText(line), Math.max(8, width - 4), { hard: true, wordWrap: false }).split("\n"));
  const start = Math.max(0, Math.min(offset, Math.max(0, (lines?.length ?? 0) - rows)));
  const listStart = Math.max(0, selection - Math.floor(rows / 4));
  return <Box flexDirection="column" height={Math.max(7, height)} width={width} borderStyle="round" paddingX={1}>
    <Text bold color="cyan">{title}</Text>
    <Text dimColor>Tab 切换 任务 / 待决定 / 排队输入 · Esc 返回，当前草稿保留</Text>
    {busy ? <Text color="yellow">正在提交 / 读取；不会重复派发</Text> : null}
    {error ? <Text color="red">{displayQuestionText(error).slice(0, 320)}</Text> : null}
    <Box flexGrow={1} overflow="hidden" flexDirection="column">
      {lines ? lines.slice(start, start + rows).map((line, index) => <Text key={`${start + index}`}>{line || " "}</Text>)
        : items.length ? items.slice(listStart, listStart + Math.max(1, Math.floor(rows / 2))).map((item, index) => <Box flexDirection="column" key={item.id}>
          <Text color={listStart + index === selection ? "cyan" : undefined} bold={listStart + index === selection}>{listStart + index === selection ? "› " : "  "}{item.title.slice(0, width - 6)}</Text>
          <Text dimColor>  {item.summary.slice(0, width - 6)}</Text>
        </Box>) : <Text dimColor>{tab === "tasks" ? "当前没有后台任务或运行中的前台执行。普通对话完成后不会保留为后台任务；可用 /task 创建长任务。" : tab === "decisions" ? "没有待处理问题" : "没有排队输入"}</Text>}
    </Box>
    {confirming ? <Text color="red">{confirming} · Y 确认 / Esc 取消</Text>
      : <Text dimColor>{lines ? `↑/↓ 滚动 · PgUp/PgDn 翻页 · ${start + 1}/${lines.length}` : `↑/↓ 选择 · Enter ${tab === "decisions" ? "回答" : "查看"} · ${items.length} 项（长任务显示最近 32 项）`}</Text>}
    <Text dimColor>{selected?.run ? `P 暂停 · R 恢复 · X 取消 · F 补充 · L ${selected.run.reason === "unknown-effects" ? "状态查询" : "限制"}` : selected?.shell ? "I 输出 / PTY 输入 · K 终止（需确认）" : tab === "queue" ? "E 取回编辑 · D 删除（需确认）" : "Ctrl+T 关闭"}</Text>
  </Box>;
}
