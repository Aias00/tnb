import { describe, expect, test } from "bun:test";

import { createAnthropicTransport } from "../../src/providers/anthropic";
import { createOpenAITransport } from "../../src/providers/openai";
import type { ModelEvent, ModelRequest } from "../../src/providers/types";

const request: ModelRequest = {
  model: "test-model",
  systemPrompt: "system",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [
    {
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
};

async function collect(stream: AsyncGenerator<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("provider transports", () => {
  test("converts Anthropic SSE into canonical events", async () => {
    let body: Record<string, unknown> | undefined;
    const transport = createAnthropicTransport({
      apiKey: "test-key",
      promptCaching: "1h",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return sseResponse([
          {
            type: "message_start",
            message: {
              usage: {
                input_tokens: 120,
                output_tokens: 1,
                cache_read_input_tokens: 80,
                cache_creation_input_tokens: 40,
              },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "read", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' } },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: {
              input_tokens: 120,
              output_tokens: 12,
              cache_read_input_tokens: 80,
              cache_creation_input_tokens: 40,
            },
          },
          { type: "message_stop" },
        ]);
      },
    });

    expect(await collect(transport.stream(request))).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 120,
          outputTokens: 0,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 40,
        },
      },
      { type: "tool-start", index: 0, id: "call-1", name: "read" },
      { type: "tool-input", index: 0, json: '{"path":"README.md"}' },
      {
        type: "usage",
        usage: {
          inputTokens: 0,
          outputTokens: 12,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      { type: "response-end", reason: "tool-use" },
    ]);
    expect(body?.model).toBe("test-model");
    expect(body?.max_tokens).toBe(32_000);
    expect(body?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body?.tools).toEqual([
      { name: "read", description: "Read a file", input_schema: request.tools[0]?.inputSchema },
    ]);
  });

  test("reads input usage first reported by a compatible gateway in message_delta", async () => {
    const transport = createAnthropicTransport({
      fetch: async () =>
        sseResponse([
          {
            type: "message_start",
            message: { usage: { output_tokens: 1 } },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: {
              input_tokens: 321,
              output_tokens: 9,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 21,
            },
          },
          { type: "message_stop" },
        ]),
    });

    expect(await collect(transport.stream(request))).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 321,
          outputTokens: 9,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 21,
        },
      },
      { type: "response-end", reason: "end-turn" },
    ]);
  });

  test("converts OpenAI tool-call deltas into canonical events", async () => {
    let body: Record<string, unknown> | undefined;
    const transport = createOpenAITransport({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return sseResponse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read", arguments: "" } }] }, finish_reason: null }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"README.md"}' } }] }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]);
      },
    });

    expect(await collect(transport.stream(request))).toEqual([
      { type: "tool-start", index: 0, id: "call-1", name: "read" },
      { type: "tool-input", index: 0, json: '{"path":"README.md"}' },
      { type: "response-end", reason: "tool-use" },
    ]);
    expect(body?.tools).toEqual([
      {
        type: "function",
        function: { name: "read", description: "Read a file", parameters: request.tools[0]?.inputSchema },
      },
    ]);
  });

  test("buffers split OpenAI tool identity deltas before emitting tool input", async () => {
    const transport = createOpenAITransport({
      fetch: async () => sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1" }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read" } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    });

    expect(await collect(transport.stream(request))).toEqual([
      { type: "tool-start", index: 0, id: "call-1", name: "read" },
      { type: "tool-input", index: 0, json: '{"path":' },
      { type: "tool-input", index: 0, json: '"README.md"}' },
      { type: "response-end", reason: "tool-use" },
    ]);
  });

  test("surfaces an Anthropic error event with its provider message", async () => {
    const transport = createAnthropicTransport({
      apiKey: "test-key",
      fetch: async () =>
        sseResponse([
          {
            type: "error",
            error: { type: "overloaded_error", message: "Service overloaded" },
          },
        ]),
    });

    await expect(collect(transport.stream(request))).rejects.toThrow(
      "Service overloaded",
    );
  });

  test("translates the one-million context model marker into the Anthropic beta header", async () => {
    let body: Record<string, unknown> | undefined;
    let headers: Headers | undefined;
    const transport = createAnthropicTransport({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        headers = new Headers(init?.headers);
        return sseResponse([
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
          { type: "message_stop" },
        ]);
      },
    });

    await collect(transport.stream({ ...request, model: "claude-sonnet-4-6[1m]" }));

    expect(body?.model).toBe("claude-sonnet-4-6");
    expect(headers?.get("anthropic-beta")).toBe("context-1m-2025-08-07");
  });

  test("sends Anthropic fast inference without changing the selected model", async () => {
    let body: Record<string, unknown> | undefined;
    let headers: Headers | undefined;
    const transport = createAnthropicTransport({
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        headers = new Headers(init?.headers);
        return sseResponse([
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
        ]);
      },
    });

    await collect(transport.stream({
      ...request,
      model: "claude-opus-4-6[1m]",
      speed: "fast",
    }));

    expect(body?.model).toBe("claude-opus-4-6");
    expect(body?.speed).toBe("fast");
    expect(headers?.get("anthropic-beta")).toBe(
      "context-1m-2025-08-07,fast-mode-2026-02-01",
    );
  });

  test("applies configured headers to Anthropic requests", async () => {
    let headers: Headers | undefined;
    const transport = createAnthropicTransport({
      apiKey: "generated-key",
      headers: {
        "x-api-key": "configured-key",
        "x-tenant": "tenant-a",
      },
      fetch: async (_input, init) => {
        headers = new Headers(init?.headers);
        return sseResponse([
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
        ]);
      },
    });

    await collect(transport.stream(request));

    expect(headers?.get("x-api-key")).toBe("configured-key");
    expect(headers?.get("x-tenant")).toBe("tenant-a");
  });

  test("applies OpenAI-compatible request options and configured headers", async () => {
    let body: Record<string, unknown> | undefined;
    let headers: Headers | undefined;
    const transport = createOpenAITransport({
      apiKey: "generated-key",
      headers: {
        authorization: "Bearer configured-key",
        "x-tenant": "tenant-a",
      },
      maxOutputTokens: 8_192,
      compat: {
        supportsDeveloperRole: true,
        maxTokensField: "max_tokens",
        supportsUsageInStreaming: true,
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "qwen",
      },
      reasoning: true,
      reasoningEffort: "high",
      samplingParams: {
        temperature: 0.2,
        top_p: 0.8,
        stream: false,
        model: "must-not-override",
      },
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        headers = new Headers(init?.headers);
        return sseResponse([
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]);
      },
    });

    await collect(transport.stream({
      ...request,
      messages: [
        ...request.messages,
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    }));

    expect(headers?.get("authorization")).toBe("Bearer configured-key");
    expect(headers?.get("x-tenant")).toBe("tenant-a");
    expect(body?.max_tokens).toBe(8_192);
    expect(body?.max_completion_tokens).toBeUndefined();
    expect(body?.stream_options).toEqual({ include_usage: true });
    expect(body?.enable_thinking).toBe(true);
    expect(body?.temperature).toBe(0.2);
    expect(body?.top_p).toBe(0.8);
    expect(body?.stream).toBe(true);
    expect(body?.model).toBe("test-model");
    expect((body?.messages as Array<Record<string, unknown>>)[0]?.role).toBe("developer");
    expect((body?.messages as Array<Record<string, unknown>>).at(-1)).toEqual({
      role: "assistant",
      content: "done",
      reasoning_content: "",
    });
  });

  test("omits unsupported OpenAI streaming usage options", async () => {
    let body: Record<string, unknown> | undefined;
    const transport = createOpenAITransport({
      compat: { supportsUsageInStreaming: false },
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return sseResponse([
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]);
      },
    });

    await collect(transport.stream(request));

    expect(body?.stream_options).toBeUndefined();
  });

  test("adapts tool-result history for providers that require names and assistant bridges", async () => {
    let body: Record<string, unknown> | undefined;
    const transport = createOpenAITransport({
      compat: {
        requiresToolResultName: true,
        requiresAssistantAfterToolResult: true,
      },
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return sseResponse([
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]);
      },
    });

    await collect(transport.stream({
      model: request.model,
      tools: request.tools,
      messages: [
        { role: "user", content: [{ type: "text", text: "inspect" }] },
        {
          role: "assistant",
          content: [{ type: "tool-use", id: "call-1", name: "read", input: { path: "README.md" } }],
        },
        {
          role: "user",
          content: [{ type: "tool-result", toolUseId: "call-1", content: "contents", isError: false }],
        },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    }));

    expect(body?.messages).toEqual([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "read", arguments: '{"path":"README.md"}' },
        }],
      },
      { role: "tool", tool_call_id: "call-1", name: "read", content: "contents" },
      { role: "assistant", content: "I have processed the tool results." },
      { role: "user", content: "continue" },
    ]);
  });

  test("maps configured reasoning effort to provider-specific request formats", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    };

    await collect(createOpenAITransport({
      reasoning: true,
      reasoningEffort: "high",
      compat: { thinkingFormat: "deepseek", supportsReasoningEffort: true },
      fetch,
    }).stream(request));
    await collect(createOpenAITransport({
      reasoning: true,
      reasoningEffort: "low",
      compat: { thinkingFormat: "openrouter" },
      fetch,
    }).stream(request));
    await collect(createOpenAITransport({
      reasoning: true,
      reasoningEffort: "off",
      compat: { thinkingFormat: "qwen", supportsReasoningEffort: true },
      fetch,
    }).stream(request));

    expect(bodies[0]?.thinking).toEqual({ type: "enabled" });
    expect(bodies[0]?.reasoning_effort).toBe("high");
    expect(bodies[1]?.reasoning).toEqual({ effort: "low" });
    expect(bodies[1]?.reasoning_effort).toBeUndefined();
    expect(bodies[2]?.enable_thinking).toBe(false);
    expect(bodies[2]?.reasoning_effort).toBeUndefined();
  });

  test("normalizes reasoning streams and replays reasoning required by compatible tool-call APIs", async () => {
    let body: Record<string, unknown> | undefined;
    const transport = createOpenAITransport({
      reasoning: true,
      compat: {
        thinkingFormat: "deepseek",
        requiresReasoningContentOnAssistantMessages: true,
      },
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return sseResponse([
          { choices: [{ delta: { reasoning_content: "inspect first" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]);
      },
    });

    expect(await collect(transport.stream({
      ...request,
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "prior tool reasoning" },
          { type: "tool-use", id: "call-1", name: "read", input: { path: "README.md" } },
        ],
      }],
    }))).toEqual([
      { type: "thinking", index: 0, thinking: "inspect first" },
      { type: "response-end", reason: "end-turn" },
    ]);
    expect((body?.messages as Array<Record<string, unknown>>).at(-1)).toMatchObject({
      role: "assistant",
      reasoning_content: "prior tool reasoning",
    });
  });

  test("normalizes OpenRouter reasoning detail streams", async () => {
    const transport = createOpenAITransport({
      compat: { thinkingFormat: "openrouter" },
      fetch: async () => sseResponse([
        { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "step" }] }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    });
    expect(await collect(transport.stream(request))).toEqual([
      { type: "thinking", index: 0, thinking: "step" },
      { type: "response-end", reason: "end-turn" },
    ]);
  });

  test("supports Anthropic-compatible gateways that reject tool_choice any", async () => {
    let body: Record<string, unknown> | undefined;
    const transport = createAnthropicTransport({
      requiredToolChoice: "auto",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return sseResponse([{ type: "message_delta", delta: { stop_reason: "end_turn" } }]);
      },
    });
    await collect(transport.stream({
      ...request,
      tools: [...request.tools, { name: "write", description: "Write", inputSchema: {} }],
      toolChoice: "required",
    }));
    expect(body?.tool_choice).toEqual({ type: "auto" });
  });

  test("accepts an explicit Anthropic message_stop when a compatible gateway omits message_delta", async () => {
    const transport = createAnthropicTransport({
      apiKey: "test",
      fetch: async () => sseResponse([
        { type: "message_start", message: { usage: { input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-1", name: "read" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
        { type: "message_stop" },
      ]),
    });

    expect(await collect(transport.stream(request))).toContainEqual({
      type: "response-end",
      reason: "tool-use",
    });
  });

  test("omits an empty tool list from provider requests", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponse([
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]);
    };
    const anthropicFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponse([
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
      ]);
    };

    await collect(createOpenAITransport({ fetch }).stream({ ...request, tools: [] }));
    await collect(createAnthropicTransport({ fetch: anthropicFetch }).stream({ ...request, tools: [] }));

    expect(bodies[0]?.tools).toBeUndefined();
    expect(bodies[1]?.tools).toBeUndefined();
  });

  test("applies request-scoped sampling controls to Anthropic and OpenAI", async () => {
    const bodies: Record<string, unknown>[] = [];
    const samplingRequest: ModelRequest = {
      ...request,
      maxOutputTokens: 37,
      temperature: 0.25,
      stopSequences: ["DONE"],
      toolChoice: "required",
    };
    const anthropic = createAnthropicTransport({
      maxOutputTokens: 9_999,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse([
          {
            type: "message_delta",
            delta: { stop_reason: "stop_sequence", stop_sequence: "DONE" },
          },
        ]);
      },
    });
    const openai = createOpenAITransport({
      maxOutputTokens: 9_999,
      compat: { maxTokensField: "max_tokens" },
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
      },
    });

    expect(await collect(anthropic.stream(samplingRequest))).toEqual([
      { type: "response-end", reason: "stop-sequence" },
    ]);
    expect(await collect(openai.stream(samplingRequest))).toEqual([
      { type: "response-end", reason: "stop-sequence" },
    ]);
    expect(bodies[0]).toMatchObject({
      max_tokens: 37,
      temperature: 0.25,
      stop_sequences: ["DONE"],
      tool_choice: { type: "tool", name: "read" },
    });
    expect(bodies[1]).toMatchObject({
      max_tokens: 37,
      temperature: 0.25,
      stop: ["DONE"],
      tool_choice: "required",
    });
  });

  test("drops non-portable reasoning blocks when replaying history to other protocols", async () => {
    const bodies: Record<string, unknown>[] = [];
    const historyRequest: ModelRequest = {
      ...request,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning", signature: '{"type":"reasoning"}' },
            { type: "text", text: "visible answer" },
          ],
        },
      ],
    };
    await collect(createOpenAITransport({
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
      },
    }).stream(historyRequest));
    await collect(createAnthropicTransport({
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse([{ type: "message_delta", delta: { stop_reason: "end_turn" } }]);
      },
    }).stream(historyRequest));

    expect((bodies[0]?.messages as Array<Record<string, unknown>>)[1]).toEqual({
      role: "assistant",
      content: "visible answer",
    });
    expect((bodies[1]?.messages as Array<Record<string, unknown>>)[0]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "visible answer" }],
    });
  });
});

function sseResponse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
