export type CompactionInfo = { strategy: "microcompact" | "full" | "context-collapse" | "unknown"; prunedToolResults?: number; collapsedMessages?: number };
export function compactionInfo(details?: Record<string, unknown>): CompactionInfo {
  const strategy = details?.strategy;
  return { strategy: strategy === "microcompact" || strategy === "full" || strategy === "context-collapse" ? strategy : "unknown",
    ...(typeof details?.prunedToolResults === "number" ? { prunedToolResults: details.prunedToolResults } : {}),
    ...(typeof details?.collapsedMessages === "number" ? { collapsedMessages: details.collapsedMessages } : {}) };
}
/** Light cleanup stays in the audit log, not the transcript. Meaningful losses remain visible. */
export class CompactionNotices {
  private seen = new Set<string>();
  reset() { this.seen.clear(); }
  message(preTokens: number, postTokens: number, info: CompactionInfo = { strategy: "unknown" }): string | undefined {
    if (info.strategy === "microcompact") return;
    const key = `${info.strategy}:${preTokens}:${postTokens}`;
    if (this.seen.has(key)) return;
    this.seen.add(key); if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value!);
    const amount = `${preTokens.toLocaleString()} → ${postTokens.toLocaleString()} 估算 tokens`;
    if (info.strategy === "full") return `已生成上下文摘要：${amount}；/compactions 查看摘要。`;
    if (info.strategy === "context-collapse") return `较早对话已折叠：${amount}；/compactions 查看整理记录。`;
    return `上下文已整理：${amount}；类型未记录，/compactions 查看记录。`;
  }
}
export function compactionLabel(strategy?: string): string {
  return strategy === "microcompact" ? "旧工具输出清理" : strategy === "full" ? "对话摘要" : strategy === "context-collapse" ? "较早对话折叠" : "历史整理（类型未记录）";
}
