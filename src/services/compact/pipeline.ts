import type { ConversationMessage, ToolResultBlock, ToolUseBlock } from "../../core/message";
import {
  compactConversation,
  estimateConversationTokens,
  type CompactConversationOptions,
  type CompactConversationResult,
} from "./compact";
import type { SessionMemoryStore } from "./session-memory";

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
}): Promise<CompactPipelineResult> {
  const original = structuredClone(options.messages);
  const preTokens = estimateConversationTokens(original);
  const micro = pruneToolResults(original, {
    keepRecent: options.keepRecentToolResults ?? 5,
    minimumChars: options.minimumToolResultChars ?? 2_000,
  });
  let working = micro.messages;
  let workingTokens = estimateConversationTokens(working);

  if (workingTokens < options.thresholdTokens && options.sessionMemory?.shouldRefresh(working, workingTokens)) {
    options.sessionMemory.refreshInBackground(working, workingTokens, options.summarize);
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
    const collapsed = collapseOldRounds(working, options.thresholdTokens);
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
        await options.sessionMemory.save(summary.text.replace(/^Conversation summary:\s*/i, ""), working, workingTokens);
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
    // Context collapse is the bounded recovery path used when the full summarizer
    // cannot produce a valid replacement. It preserves recent turns and complete
    // tool-use/result pairs, and never masks aborts or returns the original
    // over-budget history as if compaction succeeded.
    const collapsed = collapseOldRounds(working, options.thresholdTokens);
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

  const collapsed = collapseOldRounds(working, options.thresholdTokens);
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
  const resultIds = messages.flatMap((message) =>
    message.role === "user"
      ? message.content.filter((block): block is ToolResultBlock => block.type === "tool-result").map((block) => block.toolUseId)
      : []
  );
  const keepRecent = Math.max(0, options.keepRecent);
  const retained = new Set(keepRecent === 0 ? [] : resultIds.slice(-keepRecent));
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content.filter((item): item is ToolUseBlock => item.type === "tool-use")) {
      toolNames.set(block.id, block.name);
    }
  }
  let pruned = 0;
  const output = structuredClone(messages);
  for (const message of output) {
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (
        block.type !== "tool-result" || retained.has(block.toolUseId) ||
        block.content.length < pruneThreshold(toolNames.get(block.toolUseId), options.minimumChars) || block.content === PRUNED_RESULT
      ) continue;
      const tool = toolNames.get(block.toolUseId) ?? "tool";
      block.content = `${PRUNED_RESULT} ${tool}; ${block.content.length.toLocaleString()} characters.`;
      pruned += 1;
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
): { messages: ConversationMessage[]; collapsed: boolean; removed: number } {
  if (messages.length <= keepRecentMessages + 2) return { messages: structuredClone(messages), collapsed: false, removed: 0 };
  const keepFrom = findSafeUserBoundary(messages, messages.length - keepRecentMessages);
  if (keepFrom <= 2) return { messages: structuredClone(messages), collapsed: false, removed: 0 };
  const targetTokens = Math.max(1, Math.floor(thresholdTokens * 0.9));
  for (let removeThrough = 2; removeThrough <= keepFrom; removeThrough += 1) {
    const boundary = messages[removeThrough];
    if (boundary?.role !== "user" || boundary.content.some((block) => block.type === "tool-result")) continue;
    const candidate = collapsedHistory(messages, removeThrough);
    if (estimateConversationTokens(candidate) <= targetTokens) {
      return { messages: candidate, collapsed: true, removed: removeThrough };
    }
  }
  const output = collapsedHistory(messages, keepFrom);
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

function findSafeUserBoundary(messages: ConversationMessage[], preferredIndex: number): number {
  for (let index = Math.max(1, preferredIndex); index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "user" && message.content.every((block) => block.type !== "tool-result")) return index;
  }
  return messages.length;
}
