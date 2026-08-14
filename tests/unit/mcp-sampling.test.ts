import { describe, expect, test } from "bun:test";

import type { PermissionChecker } from "../../src/core/permissions";
import type { ModelEvent, ModelRequest, ModelTransport } from "../../src/providers/types";
import { McpRequestError } from "../../src/services/mcp/client";
import { createMcpSamplingHandler } from "../../src/services/mcp/sampling";

class SamplingTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly events: ModelEvent[]) {}

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    this.requests.push(structuredClone(request));
    for (const event of this.events) yield event;
  }
}

const allow: PermissionChecker = async () => ({ behavior: "allow" });

describe("MCP sampling", () => {
  test("converts a balanced tool conversation and returns tool use without executing it", async () => {
    const approvals: unknown[] = [];
    const transport = new SamplingTransport([
      { type: "thinking", index: 0, thinking: "private" },
      { type: "text", index: 1, text: "Checking." },
      { type: "tool-start", index: 2, id: "call-new", name: "weather" },
      { type: "tool-input", index: 2, json: '{"city":"Paris"}' },
      { type: "response-end", reason: "tool-use" },
    ]);
    const handler = createMcpSamplingHandler({
      serverName: "fixture",
      transport,
      model: "configured-model",
      authorize: async (_tool, input) => {
        approvals.push(input);
        return { behavior: "allow" };
      },
    });

    const result = await handler({
      messages: [
        { role: "user", content: { type: "text", text: "Weather?" } },
        {
          role: "assistant",
          content: { type: "tool_use", id: "call-old", name: "weather", input: { city: "London" } },
        },
        {
          role: "user",
          content: {
            type: "tool_result",
            toolUseId: "call-old",
            content: [{ type: "text", text: "Rain" }],
          },
        },
      ],
      systemPrompt: "Answer briefly",
      temperature: 0.2,
      maxTokens: 123,
      tools: [{
        name: "weather",
        description: "Get weather",
        inputSchema: { type: "object", properties: { city: { type: "string" } } },
      }],
      toolChoice: { mode: "required" },
    }, new AbortController().signal);

    expect(result).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "call-new", name: "weather", input: { city: "Paris" } },
      ],
      model: "configured-model",
      stopReason: "toolUse",
    });
    expect(transport.requests).toHaveLength(1);
    expect(approvals).toHaveLength(2);
    expect(approvals).toMatchObject([
      { phase: "request", server: "fixture", model: "configured-model" },
      { phase: "response", server: "fixture", model: "configured-model", stopReason: "toolUse" },
    ]);
    expect(transport.requests[0]).toMatchObject({
      model: "configured-model",
      systemPrompt: "Answer briefly",
      temperature: 0.2,
      maxOutputTokens: 123,
      toolChoice: "required",
    });
    expect(transport.requests[0]?.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool-result", toolUseId: "call-old", content: "Rain", isError: false }],
    });
  });

  test("enforces stop sequences for transports without native support", async () => {
    const transport = new SamplingTransport([
      { type: "text", index: 0, text: "hello<ST" },
      { type: "text", index: 0, text: "OP>ignored" },
      { type: "response-end", reason: "end-turn" },
    ]);
    const handler = createMcpSamplingHandler({
      serverName: "fixture",
      transport,
      model: "model",
      authorize: allow,
    });

    expect(await handler({
      messages: [{ role: "user", content: { type: "text", text: "go" } }],
      maxTokens: 20,
      stopSequences: ["<STOP>"],
    }, new AbortController().signal)).toEqual({
      role: "assistant",
      content: { type: "text", text: "hello" },
      model: "model",
      stopReason: "stopSequence",
    });
  });

  test("rejects unbalanced or mixed tool-result messages as invalid params", async () => {
    const handler = createMcpSamplingHandler({
      serverName: "fixture",
      transport: new SamplingTransport([]),
      model: "model",
      authorize: allow,
    });
    const signal = new AbortController().signal;

    try {
      await handler({
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "mixed" },
            { type: "tool_result", toolUseId: "missing", content: [] },
          ],
        }],
        maxTokens: 10,
      }, signal);
      throw new Error("Expected invalid sampling request");
    } catch (error) {
      expect(error).toBeInstanceOf(McpRequestError);
      expect((error as McpRequestError).code).toBe(-32602);
    }
  });

  test("requires explicit approval before invoking the model", async () => {
    const transport = new SamplingTransport([]);
    const handler = createMcpSamplingHandler({
      serverName: "fixture",
      transport,
      model: "model",
      authorize: async () => ({ behavior: "deny", message: "denied" }),
    });

    try {
      await handler({
        messages: [{ role: "user", content: { type: "text", text: "go" } }],
        maxTokens: 10,
      }, new AbortController().signal);
      throw new Error("Expected denied sampling request");
    } catch (error) {
      expect(error).toBeInstanceOf(McpRequestError);
      expect((error as McpRequestError).code).toBe(-1);
    }
    expect(transport.requests).toHaveLength(0);
  });
});
