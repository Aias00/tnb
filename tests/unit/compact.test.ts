import { describe, expect, test } from "bun:test";

import {
  compactConversation,
  createTransportSummarizer,
  estimateConversationTokens,
} from "../../src/services/compact/compact";
import type { ConversationMessage } from "../../src/core/message";
import type { ModelEvent, ModelRequest, ModelTransport } from "../../src/providers/types";

const history: ConversationMessage[] = [
  { role: "user", content: [{ type: "text", text: "first question" }] },
  { role: "assistant", content: [{ type: "text", text: "first answer" }] },
  { role: "user", content: [{ type: "text", text: "second question" }] },
  { role: "assistant", content: [{ type: "text", text: "second answer" }] },
  { role: "user", content: [{ type: "text", text: "recent question" }] },
  { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
];

describe("single-layer conversation compaction", () => {
  test("uses a deterministic rough token estimate", () => {
    expect(estimateConversationTokens(history)).toBe(
      Math.ceil(JSON.stringify(history).length / 4),
    );
  });

  test("summarizes old messages and preserves the most recent complete turn", async () => {
    let summarized: ConversationMessage[] = [];
    const result = await compactConversation({
      messages: history,
      thresholdTokens: 1,
      keepRecentMessages: 2,
      summarize: async (messages) => {
        summarized = messages;
        return "Summary of earlier work";
      },
    });

    expect(result.compacted).toBe(true);
    expect(summarized).toEqual(history.slice(0, 4));
    expect(result.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Conversation summary:\n\nSummary of earlier work" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "I will continue from this summary." }],
      },
      ...history.slice(4),
    ]);
    expect(result.postTokens).toBeLessThan(result.preTokens);
  });

  test("does not call the summarizer below the threshold", async () => {
    let called = false;
    const result = await compactConversation({
      messages: history,
      thresholdTokens: Number.MAX_SAFE_INTEGER,
      summarize: async () => {
        called = true;
        return "unused";
      },
    });

    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(history);
    expect(called).toBe(false);
  });

  test("builds a summary from a tool-free model request", async () => {
    let request: ModelRequest | undefined;
    const transport: ModelTransport = {
      async *stream(value): AsyncGenerator<ModelEvent> {
        request = value;
        yield { type: "text", index: 0, text: "compact " };
        yield { type: "text", index: 0, text: "summary" };
        yield { type: "response-end", reason: "end-turn" };
      },
    };
    const summarize = createTransportSummarizer({ transport, model: "small-model" });

    expect(await summarize(history.slice(0, 2))).toBe("compact summary");
    expect(request?.model).toBe("small-model");
    expect(request?.tools).toEqual([]);
    expect(request?.messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: expect.stringContaining("durable summary"),
        },
      ],
    });
  });
});
