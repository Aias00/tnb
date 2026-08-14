import { describe, expect, test } from "bun:test";

import { createOpenAIResponsesTransport } from "../../src/providers/openai-responses";
import type { ModelEvent, ModelRequest } from "../../src/providers/types";

const reasoningItem = {
  type: "reasoning",
  id: "rs-old",
  encrypted_content: "encrypted-old",
  summary: [{ type: "summary_text", text: "Read the file" }],
};

const request: ModelRequest = {
  model: "gpt-5",
  systemPrompt: "system",
  messages: [
    { role: "user", content: [{ type: "text", text: "inspect" }] },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Read the file",
          signature: JSON.stringify(reasoningItem),
        },
        { type: "tool-use", id: "call-old", name: "read", input: { path: "README.md" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool-result", toolUseId: "call-old", content: "contents", isError: false }],
    },
  ],
  tools: [
    {
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
  ],
};

async function collect(stream: AsyncGenerator<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("OpenAI Responses transport", () => {
  test("converts canonical history and Responses SSE tool calls", async () => {
    let url: URL | undefined;
    let headers: Headers | undefined;
    let body: Record<string, unknown> | undefined;
    const transport = createOpenAIResponsesTransport({
      apiKey: "secret",
      baseUrl: "https://api.openai.com/v1",
      headers: { "x-client": "tnb" },
      maxOutputTokens: 16_384,
      reasoning: true,
      reasoningEffort: "high",
      compat: { supportsDeveloperRole: true },
      fetch: async (input, init) => {
        url = new URL(String(input));
        headers = new Headers(init?.headers);
        body = JSON.parse(String(init?.body));
        return sseResponse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "reasoning", id: "rs-1", summary: [], encrypted_content: null },
          },
          {
            type: "response.reasoning_summary_text.delta",
            output_index: 0,
            delta: "Inspect first",
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "reasoning",
              id: "rs-1",
              summary: [{ type: "summary_text", text: "Inspect first" }],
              encrypted_content: "encrypted-new",
            },
          },
          {
            type: "response.output_item.added",
            output_index: 1,
            item: { type: "message", id: "msg-1", role: "assistant", content: [], status: "in_progress" },
          },
          { type: "response.output_text.delta", output_index: 1, delta: "I will read it." },
          {
            type: "response.output_item.added",
            output_index: 2,
            item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "read", arguments: "" },
          },
          { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"path":"README.md"}' },
          {
            type: "response.completed",
            response: {
              id: "resp-1",
              status: "completed",
              output: [],
              usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
            },
          },
        ]);
      },
    });

    expect(await collect(transport.stream(request))).toEqual([
      { type: "thinking", index: 0, thinking: "" },
      { type: "thinking", index: 0, thinking: "Inspect first" },
      {
        type: "thinking-signature",
        index: 0,
        signature: JSON.stringify({
          type: "reasoning",
          id: "rs-1",
          summary: [{ type: "summary_text", text: "Inspect first" }],
          encrypted_content: "encrypted-new",
        }),
      },
      { type: "text", index: 1, text: "I will read it." },
      { type: "tool-start", index: 2, id: "call-1", name: "read" },
      { type: "tool-input", index: 2, json: '{"path":"README.md"}' },
      {
        type: "usage",
        usage: {
          inputTokens: 20,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      { type: "response-end", reason: "tool-use" },
    ]);
    expect(url?.pathname).toBe("/v1/responses");
    expect(headers?.get("authorization")).toBe("Bearer secret");
    expect(headers?.get("x-client")).toBe("tnb");
    expect(body).toMatchObject({
      model: "gpt-5",
      stream: true,
      store: false,
      max_output_tokens: 16_384,
      reasoning: { effort: "high", summary: "auto" },
      input: [
        { role: "developer", content: "system" },
        { role: "user", content: [{ type: "input_text", text: "inspect" }] },
        reasoningItem,
        { type: "function_call", call_id: "call-old", name: "read", arguments: '{"path":"README.md"}' },
        { type: "function_call_output", call_id: "call-old", output: "contents" },
      ],
      tools: [{
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: request.tools[0]?.inputSchema,
      }],
    });
  });

  test("maps an incomplete max-output response to the canonical stop reason", async () => {
    const transport = createOpenAIResponsesTransport({
      fetch: async () => sseResponse([
        {
          type: "response.incomplete",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [],
          },
        },
      ]),
    });

    expect(await collect(transport.stream({ ...request, tools: [] }))).toEqual([
      { type: "response-end", reason: "max-tokens" },
    ]);
  });

  test("uses exact request-scoped sampling limits and tool choice", async () => {
    let body: Record<string, unknown> | undefined;
    const transport = createOpenAIResponsesTransport({
      maxOutputTokens: 16_384,
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return sseResponse([{
          type: "response.completed",
          response: { status: "completed", output: [] },
        }]);
      },
    });

    await collect(transport.stream({
      ...request,
      maxOutputTokens: 5,
      temperature: 0.3,
      toolChoice: "required",
      stopSequences: ["DONE"],
    }));

    expect(body?.max_output_tokens).toBe(5);
    expect(body?.temperature).toBe(0.3);
    expect(body?.tool_choice).toBe("required");
    expect(body?.stop).toBeUndefined();
  });

  test("backfills encrypted reasoning content from the terminal response", async () => {
    const transport = createOpenAIResponsesTransport({
      fetch: async () => sseResponse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "reasoning", id: "rs-1", summary: [], encrypted_content: null },
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "reasoning", id: "rs-1", summary: [], encrypted_content: null },
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              { type: "reasoning", id: "rs-1", summary: [], encrypted_content: "terminal-state" },
            ],
          },
        },
      ]),
    });

    const signatures = (await collect(transport.stream({ ...request, tools: [] })))
      .filter((event) => event.type === "thinking-signature");

    expect(signatures.at(-1)).toEqual({
      type: "thinking-signature",
      index: 0,
      signature: JSON.stringify({
        type: "reasoning",
        id: "rs-1",
        summary: [],
        encrypted_content: "terminal-state",
      }),
    });
  });
});

function sseResponse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
