import type { ConversationMessage } from "../../core/message";
import { assertBalancedToolHistory } from "../../core/history";
import type { AgentCompactionResult } from "../../core/agent-loop";
import type { ModelRequest, ModelTransport } from "../../providers/types";
import { compactConversationPipeline } from "../compact/pipeline";
import { estimateConversationTokens } from "../compact/compact";
import { createBoundedSummarizer } from "../compact/bounded-summary";
import { estimateRequestTokens, prefixWithin, requestInputLimit } from "../compact/request-budget";
import { DurableBudgetExhaustedError } from "./budget";

export class DurableContextCapacityError extends Error {}

/** Per-task working context. Full evidence stays in DurableTranscript; authority stays in systemPrompt. */
export function createDurableContext(options: {
  transport: ModelTransport; model: string; contextWindow: number; maxOutputTokens: number;
  compactThreshold: number; systemPrompt(): string; tools: ModelRequest["tools"];
  transcriptPath: string;
}) {
  const summarize = createBoundedSummarizer(options);
  const inputLimit = requestInputLimit(options.contextWindow, options.maxOutputTokens);
  let scale = 1;
  const request = (messages: ConversationMessage[]): ModelRequest => ({
    model: options.model, messages, tools: options.tools, systemPrompt: options.systemPrompt(), maxOutputTokens: options.maxOutputTokens,
  });
  const fits = (messages: ConversationMessage[], headroom = 1) => estimateRequestTokens(request(messages)) <= inputLimit * scale * headroom;
  const transport: ModelTransport = { async *stream(input, signal) {
    // Check the actual request too, after dynamic prompt/tool resolution. No reservation or I/O on refusal.
    if (estimateRequestTokens({ ...input, maxOutputTokens: options.maxOutputTokens }) > inputLimit * scale) {
      throw new Error("Context window request budget exceeded");
    }
    yield* options.transport.stream(input, signal);
  } };
  return {
    transport,
    async compact(history: ConversationMessage[], signal: AbortSignal, force = false): Promise<AgentCompactionResult> {
      signal.throwIfAborted();
      assertBalancedToolHistory(history);
      if (force) scale *= 0.7;
      if (!fits([])) throw new DurableContextCapacityError("Pinned task instructions and tool schemas exceed available model capacity; use a larger model or a smaller task");
      const original = structuredClone(history);
      let messages = structuredClone(history);
      const preTokens = estimateConversationTokens(original);
      let strategy = "none"; let cappedToolResults = 0; let summaryFailed = false;
      const historySpace = inputLimit * scale - estimateRequestTokens(request([]));
      // Cap each result in active context only. Complete output already has a durable transcript receipt.
      const resultBytes = Math.max(256, Math.min(16000, Math.floor(historySpace / 4)));
      for (const message of messages) for (const block of message.content) {
        if (block.type !== "tool-result" || Buffer.byteLength(block.content) <= resultBytes) continue;
        const marker = "\n[Tool output shortened in active context. Use durable_recall for the original result; re-check files before relying on omitted details.]";
        const head = prefixWithin(block.content, (text) => Buffer.byteLength(text + marker) <= resultBytes);
        block.content = head + marker;
        cappedToolResults++;
        strategy = "tool-output-cap";
      }
      const thresholdTokens = Math.max(1, Math.min(options.compactThreshold, Math.floor(historySpace * 0.8 / 4)));
      if (force || !fits(messages, 0.85) || estimateConversationTokens(messages) >= thresholdTokens) {
        try {
          const result = await compactConversationPipeline({ messages, thresholdTokens, force: true,
            keepRecentMessages: 6, allowToolRoundBoundary: true,
            summarize: async (source, summarySignal) => {
              try { return await summarize(source, summarySignal); }
              catch (error) { summaryFailed = true; throw error; }
            }, signal, recoverFromSummaryError: recoverable });
          messages = result.messages;
          strategy = result.strategy;
        } catch (error) {
          signal.throwIfAborted();
          // Cancellation, authority and dollar-budget failures must never become lossy continuation.
          if (!recoverable(error)) throw error;
          summaryFailed = true;
          messages = collapse(messages);
          strategy = "context-collapse";
        }
      }
      if (!fits(messages)) { messages = collapse(messages); strategy = "context-collapse"; }
      if (!fits(messages)) throw new DurableContextCapacityError("Necessary task context cannot fit the configured model capacity");
      const postTokens = estimateConversationTokens(messages);
      const changed = JSON.stringify(messages) !== JSON.stringify(original);
      if (changed && postTokens >= preTokens) throw new DurableContextCapacityError("Context recovery could not reduce the task history");
      return { compacted: changed, messages, preTokens, postTokens, details: { strategy, cappedToolResults, summaryFailed, force,
        contextWindow: options.contextWindow, inputLimit: Math.floor(inputLimit * scale), estimatedInputTokens: estimateRequestTokens(request(messages)), preTokens, postTokens } };
    },
  };

  function recoverable(error: unknown): boolean {
    return !(error instanceof DurableBudgetExhaustedError)
      && !/authority|budget exhausted|pricing|invalid provider usage|execution.*expired/i.test(error instanceof Error ? error.message : String(error));
  }

  function collapse(messages: ConversationMessage[]): ConversationMessage[] {
    const notice: ConversationMessage[] = [
      { role: "user", content: [{ type: "text", text: `[Context recovery: earlier evidence was omitted because a bounded summary was unavailable or insufficient. Archive: ${options.transcriptPath}; use durable_recall to page original task evidence. Use the pinned task contract and checkpoint; inspect current files and verification evidence before continuing. Do not assume omitted operations failed or repeat side effects blindly.]` }] },
      { role: "assistant", content: [{ type: "text", text: "I will reconcile current facts before continuing." }] },
    ];
    for (let index = 1; index <= messages.length; index++) {
      const suffix = messages.slice(index);
      try { assertBalancedToolHistory(suffix); } catch { continue; }
      const candidate = [...notice, ...suffix];
      if (estimateConversationTokens(candidate) < estimateConversationTokens(messages) && fits(candidate, 0.95)) return candidate;
    }
    throw new DurableContextCapacityError("No smaller balanced task context fits the configured capacity");
  }
}
