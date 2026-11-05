import type { ConversationMessage } from "../../core/message";
import {
  compactConversation,
  estimateConversationTokens,
  type CompactConversationOptions,
  type CompactConversationResult,
} from "./compact";
import type { SessionMemoryStore } from "./session-memory";
import { assertBalancedToolHistory, findSafeHistoryBoundary } from "../../core/history";

const PRUNED_RESULT = "[Earlier tool result pruned from active context]";

export type CompactStrategy = "none" | "microcompact" | "full" | "context-collapse";

export type CompactPipelineResult = CompactConversationResult & {
  strategy: CompactStrategy;
  prunedToolResults: number;
  collapsedMessages: number;
};

export async function compactConversationPipeline(options: CompactConversationOptions & {
  sessionMemory?: SessionMemoryStore;
  keepRecentToolResults?: number;
  minimumToolResultChars?: number;
  force?: boolean;
  historyRevision?: number;
}): Promise<CompactPipelineResult> {
  const original = structuredClone(options.messages);
  options.signal?.throwIfAborted();
  assertBalancedToolHistory(original);
  const preTokens = estimateConversationTokens(original);
  const micro = pruneToolResults(original, {
    keepRecent: options.keepRecentToolResults ?? 5,
    minimumChars: options.minimumToolResultChars ?? 2_000,
  });
  let working = micro.messages;
  let workingTokens = estimateConversationTokens(working);

  if (workingTokens < options.thresholdTokens && options.sessionMemory?.shouldRefresh(working, workingTokens)) {
    options.sessionMemory.refreshInBackground(working, workingTokens, options.summarize, options.historyRevision, options.signal);
  }

  if (!options.force && (workingTokens < options.thresholdTokens || working.length < 3)) {
    return {
      compacted: micro.pruned > 0,
      messages: working,
      preTokens,
      postTokens: workingTokens,
      strategy: micro.pruned > 0 ? "microcompact" : "none",
      prunedToolResults: micro.pruned,
      collapsedMessages: 0,
    };
  }

  if (options.sessionMemory && !options.sessionMemory.canAttemptFullCompaction()) {
    const collapsed = collapseOldRounds(working, options.thresholdTokens, options.keepRecentMessages, options.allowToolRoundBoundary);
    return {
      compacted: micro.pruned > 0 || collapsed.collapsed,
      messages: collapsed.messages,
      preTokens,
      postTokens: estimateConversationTokens(collapsed.messages),
      strategy: collapsed.collapsed ? "context-collapse" : micro.pruned ? "microcompact" : "none",
      prunedToolResults: micro.pruned,
      collapsedMessages: collapsed.removed,
    };
  }

  try {
    const full = await compactConversation({ ...options, messages: working });
    if (full.compacted) {
      const summary = full.messages[0]?.content[0];
      if (options.sessionMemory && summary?.type === "text") {
        await options.sessionMemory.save(summary.text.replace(/^Conversation summary:\s*/i, ""), working, workingTokens, options.historyRevision, options.signal);
      }
      await options.sessionMemory?.recordCompactionAttempt("full", true);
      return {
        ...full,
        preTokens,
        strategy: "full",
        prunedToolResults: micro.pruned,
        collapsedMessages: 0,
      };
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (options.recoverFromSummaryError?.(error) === false) throw error;
    // Context collapse is the bounded recovery path used when the full summarizer
    // cannot produce a valid replacement. It preserves recent turns and complete
    // tool-use/result pairs, and never masks aborts or returns the original
    // over-budget history as if compaction succeeded.
    const collapsed = collapseOldRounds(working, options.thresholdTokens, options.keepRecentMessages, options.allowToolRoundBoundary);
    await options.sessionMemory?.recordCompactionAttempt("full", false);
    if (!collapsed.collapsed) throw error;
    return {
      compacted: true,
      messages: collapsed.messages,
      preTokens,
      postTokens: estimateConversationTokens(collapsed.messages),
      strategy: "context-collapse",
      prunedToolResults: micro.pruned,
      collapsedMessages: collapsed.removed,
    };
  }

  const collapsed = collapseOldRounds(working, options.thresholdTokens, options.keepRecentMessages, options.allowToolRoundBoundary);
  working = collapsed.messages;
  workingTokens = estimateConversationTokens(working);
  return {
    compacted: micro.pruned > 0 || collapsed.collapsed,
    messages: working,
    preTokens,
    postTokens: workingTokens,
    strategy: collapsed.collapsed ? "context-collapse" : micro.pruned ? "microcompact" : "none",
    prunedToolResults: micro.pruned,
    collapsedMessages: collapsed.removed,
  };
}

export function pruneToolResults(
  messages: ConversationMessage[],
  options: { keepRecent: number; minimumChars: number },
): { messages: ConversationMessage[]; pruned: number } {
  const resultCount = messages.reduce((count, message) => count + (message.role === "user"
    ? message.content.filter((block) => block.type === "tool-result").length : 0), 0);
  const firstRetained = resultCount - Math.max(0, options.keepRecent);
  const toolNames = new Map<string, string>();
  let pruned = 0;
  let occurrence = 0;
  const output = structuredClone(messages);
  for (const message of output) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "tool-use") toolNames.set(block.id, block.name);
      continue;
    }
    for (const block of message.content) {
      if (block.type !== "tool-result") continue;
      const tool = toolNames.get(block.toolUseId) ?? "tool";
      toolNames.delete(block.toolUseId);
      const retained = occurrence++ >= firstRetained;
      if (retained || block.content.startsWith(PRUNED_RESULT) ||
        block.content.length < pruneThreshold(tool, options.minimumChars)) continue;
      const replacement = `${PRUNED_RESULT} ${tool}; ${block.content.length.toLocaleString()} characters.`;
      if (replacement.length >= block.content.length) continue;
      block.content = replacement;
      pruned++;
    }
  }
  return { messages: output, pruned };
}

function pruneThreshold(toolName: string | undefined, configuredMinimum: number): number {
  if (!toolName) return configuredMinimum;
  if (["bash", "shell_output", "web_fetch", "web_search", "grep", "codebase_investigator"].includes(toolName)) {
    return Math.min(configuredMinimum, 1_000);
  }
  if (["read", "notebook_edit"].includes(toolName)) return Math.min(configuredMinimum, 4_000);
  return configuredMinimum;
}

export function collapseOldRounds(
  messages: ConversationMessage[],
  thresholdTokens: number,
  keepRecentMessages = 8,
  allowToolRounds = false,
): { messages: ConversationMessage[]; collapsed: boolean; removed: number } {
  assertBalancedToolHistory(messages);
  const preTokens = estimateConversationTokens(messages);
  if (messages.length <= keepRecentMessages + 2) return { messages: structuredClone(messages), collapsed: false, removed: 0 };
  const keepFrom = findSafeHistoryBoundary(messages, messages.length - keepRecentMessages, allowToolRounds);
  if (keepFrom <= 2 || keepFrom === messages.length) return { messages: structuredClone(messages), collapsed: false, removed: 0 };
  const targetTokens = Math.max(1, Math.floor(thresholdTokens * 0.9));
  for (let removeThrough = 2; removeThrough <= keepFrom; removeThrough += 1) {
    const boundary = messages[removeThrough];
    if (!boundary || (!allowToolRounds && (boundary.role !== "user" || boundary.content.some((block) => block.type === "tool-result")))) continue;
    try { assertBalancedToolHistory(messages.slice(removeThrough)); } catch { continue; }
    const candidate = collapsedHistory(messages, removeThrough);
    const candidateTokens = estimateConversationTokens(candidate);
    if (candidateTokens <= targetTokens && candidateTokens < preTokens) {
      return { messages: candidate, collapsed: true, removed: removeThrough };
    }
  }
  const output = collapsedHistory(messages, keepFrom);
  if (estimateConversationTokens(output) >= preTokens) return { messages: structuredClone(messages), collapsed: false, removed: 0 };
  return { messages: output, collapsed: true, removed: keepFrom };
}

function collapsedHistory(messages: ConversationMessage[], removeThrough: number): ConversationMessage[] {
  const removed = messages.slice(0, removeThrough);
  const toolCalls = removed.reduce((total, message) => total + (
    message.role === "assistant" ? message.content.filter((block) => block.type === "tool-use").length : 0
  ), 0);
  return [
    {
      role: "user",
      content: [{
        type: "text",
        text: `<context-collapse>Earlier conversation context was collapsed: ${removed.length} messages and ${toolCalls} tool calls. Use Session Memory and recent messages for durable details.</context-collapse>`,
      }],
    },
    { role: "assistant", content: [{ type: "text", text: "I will continue from the retained context." }] },
    ...structuredClone(messages.slice(removeThrough)),
  ];
}
