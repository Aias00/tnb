import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SUBAGENT_MAX_TURNS,
  MAX_OUTPUT_TOKEN_RECOVERIES,
  runAgentLoop,
} from "../../src/core/agent-loop";
import type { ConversationMessage } from "../../src/core/message";
import { defineTool } from "../../src/core/tool";
import type { ModelEvent, ModelRequest, ModelTransport } from "../../src/providers/types";

class ScriptedTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelEvent[][]) {}

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    this.requests.push(structuredClone(request));
    const response = this.responses[this.requests.length - 1];
    if (!response) throw new Error("Scripted transport ran out of responses");
    yield* response;
  }
}

describe("agent loop", () => {
  test("accepts canonical multimodal prompt content", async () => {
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "seen" },
      { type: "response-end", reason: "end-turn" },
    ]]);

    await runAgentLoop({
      transport,
      model: "vision-model",
      prompt: [
        { type: "text", text: "inspect" },
        {
          type: "image",
          source: { type: "base64", mediaType: "image/png", data: "aW1hZ2U=" },
        },
      ],
      tools: [],
      authorize: async () => ({ behavior: "allow" }),
    });

    expect(transport.requests[0]?.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "inspect" },
        {
          type: "image",
          source: { type: "base64", mediaType: "image/png", data: "aW1hZ2U=" },
        },
      ],
    });
  });

  test("persists streamed reasoning and its replay signature before a tool result", async () => {
    const requests: ModelRequest[] = [];
    const signature = JSON.stringify({
      type: "reasoning",
      id: "rs-1",
      encrypted_content: "encrypted-state",
      summary: [{ type: "summary_text", text: "Inspect the file" }],
    });
    const transport: ModelTransport = {
      async *stream(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield { type: "thinking", index: 0, thinking: "Inspect the file" };
          yield { type: "thinking-signature", index: 0, signature };
          yield { type: "tool-start", index: 1, id: "call-1", name: "read" };
          yield { type: "tool-input", index: 1, json: '{"path":"README.md"}' };
          yield { type: "response-end", reason: "tool-use" };
          return;
        }
        yield { type: "text", index: 0, text: "done" };
        yield { type: "response-end", reason: "end-turn" };
      },
    };
    const readTool = defineTool({
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object" },
      validate(input) {
        return input as { path: string };
      },
      async execute() {
        return "contents";
      },
      access: "read",
      isReadOnly: () => true,
    });

    const result = await runAgentLoop({
      transport,
      model: "reasoning-model",
      prompt: "inspect",
      tools: [readTool],
      authorize: async () => ({ behavior: "allow" }),
    });

    expect(result.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspect the file", signature },
        { type: "tool-use", id: "call-1", name: "read", input: { path: "README.md" } },
      ],
    });
    expect(requests[1]?.messages[1]).toEqual(result.messages[1]);
  });

  test("reports tool execution lifecycle with validated input and output", async () => {
    const transport = new ScriptedTransport([
      [
        { type: "tool-start", index: 0, id: "call-life", name: "echo" },
        { type: "tool-input", index: 0, json: '{"text":"hello"}' },
        { type: "response-end", reason: "tool-use" },
      ],
      [
        { type: "text", index: 0, text: "done" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);
    const events: unknown[] = [];
    const echoTool = defineTool({
      name: "echo",
      description: "Echo text",
      inputSchema: { type: "object" },
      validate(input) {
        return input as { text: string };
      },
      async execute(input) {
        return input.text;
      },
      access: "read",
    });

    await runAgentLoop({
      transport,
      model: "test",
      prompt: "echo",
      tools: [echoTool],
      authorize: async () => ({ behavior: "allow" }),
      onToolEvent: (event) => events.push(event),
    });

    expect(events).toEqual([
      {
        type: "tool-execution-start",
        id: "call-life",
        name: "echo",
        input: { text: "hello" },
        startedAt: expect.any(Number),
      },
      {
        type: "tool-execution-end",
        id: "call-life",
        name: "echo",
        output: "hello",
        isError: false,
        durationMs: expect.any(Number),
      },
    ]);
  });

  test("forwards structured tool progress without replacing the final result", async () => {
    const transport = new ScriptedTransport([
      [
        { type: "tool-start", index: 0, id: "call-progress", name: "echo" },
        { type: "tool-input", index: 0, json: "{}" },
        { type: "response-end", reason: "tool-use" },
      ],
      [
        { type: "text", index: 0, text: "done" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);
    const events: unknown[] = [];
    const tool = defineTool({
      name: "echo",
      description: "Echo",
      inputSchema: { type: "object" },
      validate: () => ({}),
      async execute(_input, _signal, onProgress) {
        onProgress?.({ output: "partial", fullOutput: "partial", totalLines: 1, totalBytes: 7 });
        return "final";
      },
    });

    await runAgentLoop({
      transport,
      model: "test",
      prompt: "run",
      tools: [tool],
      authorize: async () => ({ behavior: "allow" }),
      onToolEvent: (event) => events.push(event),
    });

    expect(events).toContainEqual({
      type: "tool-execution-progress",
      id: "call-progress",
      name: "echo",
      data: { output: "partial", fullOutput: "partial", totalLines: 1, totalBytes: 7 },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool-execution-end",
      output: "final",
      isError: false,
    }));
  });
  test("uses the established 200-turn subagent limit", () => {
    expect(DEFAULT_SUBAGENT_MAX_TURNS).toBe(200);
  });

  test("executes a tool and sends its result into the next model turn", async () => {
    const transport = new ScriptedTransport([
      [
        { type: "tool-start", index: 0, id: "call-1", name: "echo" },
        { type: "tool-input", index: 0, json: '{"value":"hello"}' },
        { type: "response-end", reason: "tool-use" },
      ],
      [
        { type: "text", index: 0, text: "finished" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);
    const calls: unknown[] = [];
    const echo = defineTool({
      name: "echo",
      description: "Echo a string",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      validate(input) {
        if (typeof input !== "object" || input === null || typeof (input as { value?: unknown }).value !== "string") {
          throw new Error("value must be a string");
        }
        return input as { value: string };
      },
      async execute(input) {
        calls.push(input);
        return `echo:${input.value}`;
      },
      access: "read",
    });

    const text: string[] = [];
    const result = await runAgentLoop({
      transport,
      model: "test-model",
      prompt: "use echo",
      tools: [echo],
      authorize: async () => ({ behavior: "allow" }),
      onEvent(event) {
        if (event.type === "text") text.push(event.text);
      },
    });

    expect(calls).toEqual([{ value: "hello" }]);
    expect(text.join("")).toBe("finished");
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool-result",
          toolUseId: "call-1",
          content: "echo:hello",
          isError: false,
        },
      ],
    });
    expect(result.stopReason).toBe("end-turn");
  });

  test("continues from restored messages and reports only newly appended messages", async () => {
    const history: ConversationMessage[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "remembered" }] },
    ];
    const transport = new ScriptedTransport([
      [
        { type: "text", index: 0, text: "continued" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);
    const appended: ConversationMessage[] = [];

    await runAgentLoop({
      transport,
      model: "test-model",
      prompt: "second",
      messages: history,
      tools: [],
      authorize: async () => ({ behavior: "allow" }),
      onMessage: (message) => void appended.push(message),
    });

    expect(transport.requests[0]?.messages).toEqual([
      ...history,
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]);
    expect(appended).toEqual([
      { role: "user", content: [{ type: "text", text: "second" }] },
      { role: "assistant", content: [{ type: "text", text: "continued" }] },
    ]);
  });

  test("replaces active history when the compaction callback returns a boundary", async () => {
    const history: ConversationMessage[] = [
      { role: "user", content: [{ type: "text", text: "old question" }] },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
    ];
    const compacted: ConversationMessage[] = [
      { role: "user", content: [{ type: "text", text: "Conversation summary:\n\nOld work" }] },
      { role: "assistant", content: [{ type: "text", text: "Continuing." }] },
      { role: "user", content: [{ type: "text", text: "current question" }] },
    ];
    const transport = new ScriptedTransport([
      [
        { type: "text", index: 0, text: "done" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);
    const boundaries: unknown[] = [];

    const result = await runAgentLoop({
      transport,
      model: "test-model",
      prompt: "current question",
      messages: history,
      tools: [],
      authorize: async () => ({ behavior: "allow" }),
      compactMessages: async (messages) => {
        expect(messages).toEqual([
          ...history,
          { role: "user", content: [{ type: "text", text: "current question" }] },
        ]);
        return { compacted: true, messages: compacted, preTokens: 100, postTokens: 20 };
      },
      onCompact: (boundary) => void boundaries.push(boundary),
    });

    expect(transport.requests[0]?.messages).toEqual(compacted);
    expect(boundaries).toEqual([
      { compacted: true, messages: compacted, preTokens: 100, postTokens: 20 },
    ]);
    expect(result.messages).toEqual([
      ...compacted,
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
  });

  test("does not impose a default main-agent turn limit", async () => {
    let turn = 0;
    const transport: ModelTransport = {
      async *stream(): AsyncGenerator<ModelEvent> {
        if (turn < 21) {
          turn += 1;
          yield { type: "tool-start", index: 0, id: `call-${turn}`, name: "noop" };
          yield { type: "tool-input", index: 0, json: "{}" };
          yield { type: "response-end", reason: "tool-use" };
          return;
        }
        yield { type: "text", index: 0, text: "finished" };
        yield { type: "response-end", reason: "end-turn" };
      },
    };
    const noop = defineTool({
      name: "noop",
      description: "Return immediately",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      validate: () => ({}),
      execute: async () => "ok",
      access: "read",
    });

    const result = await runAgentLoop({
      transport,
      model: "test-model",
      prompt: "continue",
      tools: [noop],
      authorize: async () => ({ behavior: "allow" }),
    });

    expect(turn).toBe(21);
    expect(result.stopReason).toBe("end-turn");
  });

  test("continues a response that reaches the output token limit", async () => {
    const transport = new ScriptedTransport([
      [
        { type: "text", index: 0, text: "partial " },
        { type: "response-end", reason: "max-tokens" },
      ],
      [
        { type: "text", index: 0, text: "completion" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);

    const result = await runAgentLoop({
      transport,
      model: "test-model",
      prompt: "write a long answer",
      tools: [],
      authorize: async () => ({ behavior: "allow" }),
    });

    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: expect.stringContaining("Continue directly") }],
    });
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "completion" }],
    });
    expect(result.stopReason).toBe("end-turn");
  });

  test("stops after the established output token recovery limit", async () => {
    const truncatedResponse: ModelEvent[] = [
      { type: "text", index: 0, text: "partial" },
      { type: "response-end", reason: "max-tokens" },
    ];
    const transport = new ScriptedTransport(
      Array.from(
        { length: MAX_OUTPUT_TOKEN_RECOVERIES + 1 },
        () => structuredClone(truncatedResponse),
      ),
    );

    const result = await runAgentLoop({
      transport,
      model: "test-model",
      prompt: "write a very long answer",
      tools: [],
      authorize: async () => ({ behavior: "allow" }),
    });

    expect(transport.requests).toHaveLength(MAX_OUTPUT_TOKEN_RECOVERIES + 1);
    expect(result.stopReason).toBe("max-tokens");
    expect(
      result.messages.filter(
        (message) =>
          message.role === "user" &&
          message.content.some(
            (block) => block.type === "text" && block.text.includes("Continue directly"),
          ),
      ),
    ).toHaveLength(MAX_OUTPUT_TOKEN_RECOVERIES);
  });
});
