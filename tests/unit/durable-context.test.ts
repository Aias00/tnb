import { expect, test } from "bun:test";
import { createDurableContext } from "../../src/services/runtime/context";
import { createBoundedSummarizer } from "../../src/services/compact/bounded-summary";
import { estimateRequestTokens, requestInputLimit } from "../../src/services/compact/request-budget";
import { assertBalancedToolHistory } from "../../src/core/history";
import { runAgentLoop } from "../../src/core/agent-loop";
import { defineTool } from "../../src/core/tool";
import { DurableBudgetExhaustedError } from "../../src/services/runtime/budget";
import type { ConversationMessage } from "../../src/core/message";
import type { ModelRequest, ModelTransport } from "../../src/providers/types";

function history(rounds = 12, size = 400): ConversationMessage[] {
  const messages: ConversationMessage[] = [{ role: "user", content: [{ type: "text", text: "调查代码，保留约束" }] }];
  for (let index = 0; index < rounds; index++) messages.push(
    { role: "assistant", content: [{ type: "tool-use", id: `read-${index}`, name: "read", input: { path: `file-${index}.ts` } }] },
    { role: "user", content: [{ type: "tool-result", toolUseId: `read-${index}`, content: `result-${index} ` + "代码😀".repeat(size), isError: false }] },
  );
  return messages;
}
function manager(transport: ModelTransport, systemPrompt = "Pinned goal: finish the authorized task") {
  return createDurableContext({ transport, model: "small", contextWindow: 12000, maxOutputTokens: 512,
    compactThreshold: 24000, tools: [{ name: "read", description: "read code", inputSchema: {} }],
    systemPrompt: () => systemPrompt, transcriptPath: "/state/task/transcript.jsonl" });
}
const signal = () => new AbortController().signal;

test("small-window compaction bounds Chinese/Unicode/tool requests and preserves complete recent rounds", async () => {
  const requests: ModelRequest[] = [];
  const transport: ModelTransport = { async *stream(request) {
    requests.push(request);
    expect(estimateRequestTokens(request)).toBeLessThanOrEqual(requestInputLimit(12000, request.maxOutputTokens ?? 512));
    yield { type: "text", index: 0, text: "Checked earlier files; remaining work is file-11.ts." };
    yield { type: "response-end", reason: "end-turn" };
  } };
  const source = history(); const original = structuredClone(source); const context = manager(transport);
  const result = await context.compact(source, signal());
  expect(result.compacted).toBe(true); expect(result.postTokens).toBeLessThan(result.preTokens);
  expect(source).toEqual(original); expect(() => assertBalancedToolHistory(result.messages)).not.toThrow();
  expect(JSON.stringify(result.messages)).toContain("read-11");
  expect(result.details?.estimatedInputTokens as number).toBeLessThanOrEqual(result.details?.inputLimit as number);
  for await (const _event of context.transport.stream({ model: "small", messages: result.messages, tools: [], systemPrompt: "Pinned goal" })) {}
  expect(requests.length).toBeGreaterThan(1);
});

test("summary chunks adapt to a provider window smaller than advertised without tools or unbounded requests", async () => {
  let requests = 0; let rejected = 0;
  const summarize = createBoundedSummarizer({ model: "small", contextWindow: 16000, maxOutputTokens: 512,
    transport: { async *stream(request) {
      requests++;
      expect(request.tools).toEqual([]); expect(request.maxOutputTokens).toBe(512);
      expect(estimateRequestTokens(request)).toBeLessThanOrEqual(requestInputLimit(16000, 512));
      if (estimateRequestTokens(request) > 4000) { rejected++; throw new Error("maximum context length exceeded"); }
      yield { type: "text", index: 0, text: "Earlier completed reads; continue investigation." };
      yield { type: "response-end", reason: "end-turn" };
    } } });
  expect(await summarize(history(5, 300), signal())).toContain("continue investigation");
  expect(rejected).toBe(2); expect(requests).toBeGreaterThan(3); expect(requests).toBeLessThanOrEqual(64);
});

test("one huge tool output is capped only in working context; failed summaries have a balanced bounded fallback", async () => {
  const context = manager({ async *stream() { throw new Error("summary unavailable"); } });
  const source = history(8, 2000);
  const result = await context.compact(source, signal());
  expect(result.compacted).toBe(true);
  expect(result.details?.cappedToolResults).toBe(8);
  expect(() => assertBalancedToolHistory(result.messages)).not.toThrow();
  expect(JSON.stringify(result.messages)).toContain("read-7");
  expect(JSON.stringify(source)).not.toContain("shortened in active context");
  expect(result.details?.estimatedInputTokens as number).toBeLessThanOrEqual(result.details?.inputLimit as number);
});

test("pinned instructions and actual oversized requests are refused before any model I/O", async () => {
  let calls = 0;
  const context = manager({ async *stream() { calls++; yield { type: "response-end", reason: "end-turn" }; } }, "x".repeat(20000));
  await expect(context.compact(history(), signal())).rejects.toThrow("Pinned task instructions");
  await expect((async () => { for await (const _event of context.transport.stream({ model: "small", messages: history(), tools: [] })) {} })()).rejects.toThrow("Context window");
  expect(calls).toBe(0);
});

test("abort, authority loss and exhausted shared budgets cannot turn into lossy continuation", async () => {
  for (const error of [new DurableBudgetExhaustedError("Durable run budget exhausted"), new Error("Execution authority expired or changed")]) {
    const context = manager({ async *stream() { throw error; } });
    await expect(context.compact(history(), signal())).rejects.toBe(error);
  }
  const controller = new AbortController();
  const context = manager({ async *stream() { controller.abort(new Error("cancelled")); throw new Error("summary unavailable"); } });
  await expect(context.compact(history(), controller.signal)).rejects.toThrow("cancelled");
});

test("a real loop force-compacts and retries a provider overflow without executing duplicate tools", async () => {
  let mainRequests = 0; const boundaries: Array<Record<string, unknown> | undefined> = [];
  const tools = [{ name: "read", description: "read code", inputSchema: {} }];
  const context = manager({ async *stream(request) {
    if (request.tools.length && ++mainRequests === 1) throw new Error("prompt is too long");
    yield { type: "text", index: 0, text: request.tools.length ? "Finished" : "Earlier reads reconciled." };
    yield { type: "response-end", reason: "end-turn" };
  } });
  const result = await runAgentLoop({ transport: context.transport, model: "small", prompt: "Continue the original goal", messages: history(6, 100),
    systemPrompt: "Pinned goal", tools: tools.map((tool) => defineTool({ ...tool, validate: (input: unknown) => input,
      execute: async () => { throw new Error("Must not execute any historical tool"); } })),
    authorize: async () => ({ behavior: "allow" }), maxTurns: 3,
    compactMessages: (messages, signal, reason) => context.compact(messages, signal, reason?.reason === "context-overflow"),
    onCompact: (result) => { boundaries.push(result.details); },
  });
  expect(result.stopReason).toBe("end-turn"); expect(mainRequests).toBe(2);
  expect(boundaries.some((item) => item?.force === true)).toBe(true);
});
