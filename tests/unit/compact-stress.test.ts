import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConversationMessage } from "../../src/core/message";
import { estimateConversationTokens } from "../../src/services/compact/compact";
import { compactConversationPipeline } from "../../src/services/compact/pipeline";
import { SessionMemoryStore } from "../../src/services/compact/session-memory";
import { SessionStore } from "../../src/services/session/storage";

const directories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "tnb-compact-stress-"));
  directories.push(directory);
  return directory;
}

async function waitFor<T>(load: () => Promise<T>, predicate: (value: T) => boolean, attempts = 50): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await load();
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(10);
  }
  if (lastError) throw lastError;
  throw new Error("Timed out waiting for condition");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function text(size: number, seed: string) {
  return `${seed}:${"x".repeat(size)}`;
}

function largeConversation(rounds: number, chunkSize: number): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (let index = 0; index < rounds; index += 1) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: text(chunkSize, `user-${index}`) }],
    });
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: text(chunkSize, `assistant-${index}`) }],
    });
  }
  return messages;
}

function toolHeavyConversation(toolResults: number, resultChars: number): ConversationMessage[] {
  const messages: ConversationMessage[] = [
    { role: "user", content: [{ type: "text", text: "start" }] },
    { role: "assistant", content: [{ type: "text", text: "ready" }] },
  ];
  for (let index = 0; index < toolResults; index += 1) {
    const toolUseId = `tool-${index}`;
    messages.push({
      role: "assistant",
      content: [{ type: "tool-use", id: toolUseId, name: "bash", input: { cmd: `echo ${index}` } }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool-result", toolUseId, content: text(resultChars, `result-${index}`), isError: false }],
    });
    messages.push({
      role: "user",
      content: [{ type: "text", text: text(1_500, `follow-up-${index}`) }],
    });
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: text(1_200, `answer-${index}`) }],
    });
  }
  return messages;
}

describe("long-context stress coverage", () => {
  test("prunes oversized historical tool results while keeping the newest results intact", async () => {
    const messages = toolHeavyConversation(18, 24_000);
    expect(estimateConversationTokens(messages)).toBeGreaterThan(100_000);

    const result = await compactConversationPipeline({
      messages,
      thresholdTokens: Number.MAX_SAFE_INTEGER,
      keepRecentToolResults: 3,
      minimumToolResultChars: 2_000,
      summarize: async () => {
        throw new Error("summarizer should not run");
      },
    });

    expect(result.strategy).toBe("microcompact");
    expect(result.prunedToolResults).toBe(15);
    expect(result.collapsedMessages).toBe(0);
    expect(result.postTokens).toBeLessThan(result.preTokens);

    const prunedResults = result.messages.flatMap((message) =>
      message.role === "user"
        ? message.content.filter((block) => block.type === "tool-result" && block.content.includes("[Earlier tool result pruned"))
        : []
    );
    const retainedIds = result.messages.flatMap((message) =>
      message.role === "user"
        ? message.content
          .filter((block): block is Extract<typeof block, { type: "tool-result" }> =>
            block.type === "tool-result" && !block.content.includes("[Earlier tool result pruned"))
          .map((block) => block.toolUseId)
        : []
    );

    expect(prunedResults).toHaveLength(15);
    expect(retainedIds.slice(-3)).toEqual(["tool-15", "tool-16", "tool-17"]);
  });

  test("falls back to context collapse for a 100k plus transcript when the summarizer fails", async () => {
    const messages = largeConversation(24, 9_000);
    expect(estimateConversationTokens(messages)).toBeGreaterThan(100_000);

    const result = await compactConversationPipeline({
      messages,
      thresholdTokens: 20_000,
      keepRecentMessages: 8,
      summarize: async () => {
        throw new Error("synthetic summarizer failure");
      },
    });

    expect(result.compacted).toBe(true);
    expect(result.strategy).toBe("context-collapse");
    expect(result.collapsedMessages).toBeGreaterThan(0);
    expect(result.postTokens).toBeLessThan(result.preTokens);
    expect(result.messages[0]).toEqual({
      role: "user",
      content: [{
        type: "text",
        text: expect.stringContaining("<context-collapse>Earlier conversation context was collapsed:"),
      }],
    });
    expect(result.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "I will continue from the retained context." }],
    });
    expect(result.messages.slice(-8)).toEqual(messages.slice(-8));
  });

  test("deduplicates background Session Memory refresh work for large histories", async () => {
    const directory = await temporaryDirectory();
    const memory = new SessionMemoryStore(join(directory, "session-memory.json"));
    await memory.initialize();
    const messages = toolHeavyConversation(18, 24_000);
    const tokenCount = estimateConversationTokens(messages);
    expect(tokenCount).toBeGreaterThan(60_000);

    let summarizeCalls = 0;
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });

    const summarize = async () => {
      summarizeCalls += 1;
      await done;
      return "Background durable summary";
    };

    memory.refreshInBackground(messages, tokenCount, summarize);
    memory.refreshInBackground(messages, tokenCount, summarize);
    expect(summarizeCalls).toBe(1);

    release();

    const snapshot = await waitFor(
      async () => JSON.parse(await readFile(join(directory, "session-memory.json"), "utf8")) as {
        summary: string;
        tokenCount: number;
        messageCount: number;
      },
      (value) => value.summary === "Background durable summary",
    );
    expect(snapshot.summary).toBe("Background durable summary");
    expect(snapshot.tokenCount).toBe(tokenCount);
    expect(snapshot.messageCount).toBe(messages.length);
  });

  test("restores the latest large compact boundary consistently across repeated reads", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const store = new SessionStore({ configDir, cwd, sessionId: "stress-session" });
    const original = largeConversation(16, 4_500);
    const compacted = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: `Conversation summary:\n\n${text(12_000, "summary")}` }],
      },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "I will continue from this summary." }],
      },
    ];
    const nextTurn: ConversationMessage[] = [
      { role: "user", content: [{ type: "text", text: text(6_000, "next-user") }] },
      { role: "assistant", content: [{ type: "text", text: text(5_000, "next-assistant") }] },
    ];

    await store.append(original);
    await store.appendCompactBoundary({
      messages: compacted,
      preTokens: estimateConversationTokens(original),
      postTokens: estimateConversationTokens(compacted),
      permissionMode: "plan",
      prePlanMode: "acceptEdits",
    });
    await store.append(nextTurn);

    const first = await store.readState();
    const second = await store.readState();

    expect(first).toEqual(second);
    expect(first.messages).toEqual([...compacted, ...nextTurn]);
    expect(first.permissionMode).toBe("plan");
    expect(first.prePlanMode).toBe("acceptEdits");
    expect(estimateConversationTokens(first.messages)).toBeGreaterThan(4_000);
  });

  test("is idempotent when rerunning compaction on already collapsed large context", async () => {
    const messages = largeConversation(24, 9_000);
    const first = await compactConversationPipeline({
      messages,
      thresholdTokens: 20_000,
      keepRecentMessages: 8,
      summarize: async () => {
        throw new Error("synthetic summarizer failure");
      },
    });

    const second = await compactConversationPipeline({
      messages: first.messages,
      thresholdTokens: 20_000,
      keepRecentMessages: 8,
      summarize: async () => "unused summary",
    });

    expect(first.strategy).toBe("context-collapse");
    expect(second.compacted).toBe(false);
    expect(second.strategy).toBe("none");
    expect(second.messages).toEqual(first.messages);
    expect(second.preTokens).toBe(second.postTokens);
  });

  test("never leaves an orphaned tool result after collapsing a 100k plus tool transcript", async () => {
    const messages = toolHeavyConversation(24, 22_000);
    expect(estimateConversationTokens(messages)).toBeGreaterThan(100_000);

    const result = await compactConversationPipeline({
      messages,
      thresholdTokens: 35_000,
      keepRecentMessages: 12,
      keepRecentToolResults: 100,
      summarize: async () => {
        throw new Error("synthetic summarizer failure");
      },
    });

    expect(result.strategy).toBe("context-collapse");
    expect(result.postTokens).toBeLessThan(result.preTokens);
    const toolUses = new Set(result.messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.filter((block) => block.type === "tool-use").map((block) => block.id)
        : []
    ));
    const toolResults = result.messages.flatMap((message) =>
      message.role === "user"
        ? message.content.filter((block) => block.type === "tool-result").map((block) => block.toolUseId)
        : []
    );
    expect(toolResults.length).toBeGreaterThan(0);
    expect(toolResults.every((id) => toolUses.has(id))).toBe(true);
  });

  test("updates and restores Session Memory across consecutive 100k compactions", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "session-memory.json");
    const memory = new SessionMemoryStore(path);
    await memory.initialize();
    const firstMessages = largeConversation(24, 9_000);
    const first = await compactConversationPipeline({
      messages: firstMessages,
      thresholdTokens: 20_000,
      keepRecentMessages: 8,
      sessionMemory: memory,
      summarize: async () => "first durable checkpoint",
    });
    expect(first.strategy).toBe("full");
    expect(memory.current()?.summary).toBe("first durable checkpoint");

    const secondMessages = [...first.messages, ...largeConversation(20, 9_000)];
    expect(estimateConversationTokens(secondMessages)).toBeGreaterThan(80_000);
    const second = await compactConversationPipeline({
      messages: secondMessages,
      thresholdTokens: 20_000,
      keepRecentMessages: 8,
      sessionMemory: memory,
      summarize: async () => "second durable checkpoint",
    });
    expect(second.strategy).toBe("full");
    expect(memory.current()?.summary).toBe("second durable checkpoint");

    const restored = new SessionMemoryStore(path);
    await restored.initialize();
    expect(restored.current()).toEqual(memory.current());
    expect(restored.prompt()).toContain("second durable checkpoint");
  });

  test("preserves cumulative usage across multiple large compact boundaries", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const store = new SessionStore({ configDir, cwd, sessionId: "usage-compact-stress" });
    const original = largeConversation(24, 9_000);
    expect(estimateConversationTokens(original)).toBeGreaterThan(100_000);
    await store.append(original);
    await store.appendUsage({
      provider: "yuanjing",
      model: "glm-5",
      usage: { inputTokens: 100_000, outputTokens: 4_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      costUsd: 1.25,
    });

    const first = await compactConversationPipeline({
      messages: original,
      thresholdTokens: 20_000,
      summarize: async () => "first boundary",
    });
    await store.appendCompactBoundary({
      messages: first.messages,
      preTokens: first.preTokens,
      postTokens: first.postTokens,
      permissionMode: "bypassPermissions",
    });
    const next = largeConversation(18, 8_000);
    await store.append(next);
    await store.appendUsage({
      provider: "yuanjing",
      model: "glm-5",
      usage: { inputTokens: 70_000, outputTokens: 3_000, cacheReadInputTokens: 10_000, cacheCreationInputTokens: 0 },
      costUsd: 0.75,
    });
    const second = await compactConversationPipeline({
      messages: [...first.messages, ...next],
      thresholdTokens: 20_000,
      summarize: async () => "second boundary",
    });
    await store.appendCompactBoundary({
      messages: second.messages,
      preTokens: second.preTokens,
      postTokens: second.postTokens,
      permissionMode: "bypassPermissions",
    });

    const restored = await store.readState();
    expect(restored.messages).toEqual(second.messages);
    expect(restored.permissionMode).toBe("bypassPermissions");
    expect(restored.usage).toEqual({
      inputTokens: 170_000,
      outputTokens: 7_000,
      cacheReadInputTokens: 10_000,
      cacheCreationInputTokens: 0,
      costUsd: 2,
    });
    expect(await store.readState()).toEqual(restored);
  });
});
