import type { ConversationMessage } from "../../core/message";
import type { ModelTransport } from "../../providers/types";
import { assertBalancedToolHistory, findSafeHistoryBoundary } from "../../core/history";

export type CompactConversationOptions = {
  messages: ConversationMessage[];
  thresholdTokens: number;
  keepRecentMessages?: number;
  /** Durable workers may retain complete tool rounds without a new human input. */
  allowToolRoundBoundary?: boolean;
  recoverFromSummaryError?(error: unknown): boolean;
  summarize(
    messages: ConversationMessage[],
    signal?: AbortSignal,
  ): Promise<string>;
  signal?: AbortSignal;
  force?: boolean;
};

export type CompactConversationResult = {
  compacted: boolean;
  messages: ConversationMessage[];
  preTokens: number;
  postTokens: number;
};

export function estimateConversationTokens(messages: ConversationMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export function createTransportSummarizer(options: {
  transport: ModelTransport;
  model: string;
}): CompactConversationOptions["summarize"] {
  return async (messages, signal) => {
    const summaryRequest: ConversationMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "Create a durable summary of the conversation for another coding agent.",
            "Preserve decisions, files changed, commands or tests run, unresolved problems, and the user's current goal.",
            "Be concise and do not ask follow-up questions.",
          ].join(" "),
        },
      ],
    };
    let text = "";
    let completed = false;
    for await (const event of options.transport.stream(
      {
        model: options.model,
        messages: [...structuredClone(messages), summaryRequest],
        tools: [],
      },
      signal,
    )) {
      if (event.type === "text") text += event.text;
      if (event.type === "response-end") completed = event.reason === "end-turn" || event.reason === "stop-sequence";
      if (event.type === "tool-start" || event.type === "tool-input") {
        throw new Error("Conversation summarizer attempted to call a tool");
      }
    }
    if (!completed) throw new Error("Conversation summarizer did not complete successfully");
    if (!text.trim()) throw new Error("Conversation summarizer returned empty text");
    return text.trim();
  };
}

export async function compactConversation(
  options: CompactConversationOptions,
): Promise<CompactConversationResult> {
  const original = structuredClone(options.messages);
  const preTokens = estimateConversationTokens(original);
  if ((!options.force && preTokens < options.thresholdTokens) || original.length < 3) {
    return { compacted: false, messages: original, preTokens, postTokens: preTokens };
  }

  assertBalancedToolHistory(original);
  const keepFrom = findSafeHistoryBoundary(
    original,
    Math.max(0, original.length - (options.keepRecentMessages ?? 4)),
    options.allowToolRoundBoundary,
  );
  if (keepFrom <= 0) {
    return { compacted: false, messages: original, preTokens, postTokens: preTokens };
  }

  options.signal?.throwIfAborted();
  const summary = (await options.summarize(original.slice(0, keepFrom), options.signal)).trim();
  if (!summary) throw new Error("Conversation summarizer returned empty text");
  options.signal?.throwIfAborted();

  const messages: ConversationMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: `Conversation summary:\n\n${summary}` }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "I will continue from this summary." }],
    },
    ...original.slice(keepFrom),
  ];
  assertBalancedToolHistory(messages);
  const postTokens = estimateConversationTokens(messages);
  if (postTokens >= preTokens) throw new Error("Compaction replacement must be smaller than its source history");
  return {
    compacted: true,
    messages,
    preTokens,
    postTokens,
  };
}
