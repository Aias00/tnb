import { expect, test } from "bun:test";
import { contextReport, formatContextReport } from "../../src/services/compact/context-report";

test("actual requests expose system, tools and tool results separately without counting base64 as text", () => {
  const report = contextReport({ contextWindow: 200000, maxOutputTokens: 4000, messages: [], request: {
    model: "fixture", systemPrompt: "project instruction", tools: [{ name: "read", description: "read files", inputSchema: { type: "object" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "inspect" }, { type: "tool-result", toolUseId: "r", content: "output", isError: false }, { type: "image", source: { type: "base64", mediaType: "image/png", data: "a".repeat(100000) } }] }],
  } });
  expect(report.source).toBe("request"); expect(report.mediaBlocks).toBe(1); expect(report.estimatedInput).toBeLessThan(1000);
  expect(report.categories.map(item => item.name)).toEqual(expect.arrayContaining(["System instructions", "Tool definitions", "Conversation text", "Tool results"]));
  expect(report.outputReserve).toBe(4000);
  expect(formatContextReport(report)).toContain("token cost not included");
});

test("history-only reports explicitly leave system/tools/output reserve unknown", () => {
  const report = contextReport({ contextWindow: 1000, messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] });
  expect(report.source).toBe("history"); expect(report.outputReserve).toBeUndefined();
  expect(formatContextReport(report)).toContain("unavailable until the next model request");
});
