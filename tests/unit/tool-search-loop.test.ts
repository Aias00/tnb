import { describe, expect, test } from "bun:test";

import { runAgentLoop } from "../../src/core/agent-loop";
import { defineTool } from "../../src/core/tool";
import { createDeferredToolCatalog } from "../../src/core/tool-search";
import { createToolSearchTool } from "../../src/tools/tool-search";
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

describe("agent loop deferred tool schemas", () => {
  test("exposes only tool_search until a deferred tool is activated", async () => {
    const read = defineTool({
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      validate(input) {
        return input as { path: string };
      },
      async execute() {
        return "read";
      },
      access: "read",
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    });
    const write = defineTool({
      name: "write",
      description: "Write a file",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      validate(input) {
        return input as { path: string; content: string };
      },
      async execute(input) {
        return `wrote:${input.path}:${input.content}`;
      },
      access: "write",
    });
    const catalog = createDeferredToolCatalog([read, write], { threshold: 1 });
    const toolSearch = createToolSearchTool(catalog);
    catalog.setAuxiliaryTools([toolSearch]);
    const transport = new ScriptedTransport([
      [
        { type: "tool-start", index: 0, id: "call-search", name: "tool_search" },
        { type: "tool-input", index: 0, json: "{\"query\":\"write file\"}" },
        { type: "response-end", reason: "tool-use" },
      ],
      [
        { type: "tool-start", index: 0, id: "call-write", name: "write" },
        { type: "tool-input", index: 0, json: "{\"path\":\"notes.txt\",\"content\":\"hello\"}" },
        { type: "response-end", reason: "tool-use" },
      ],
      [
        { type: "text", index: 0, text: "done" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);

    const result = await runAgentLoop({
      transport,
      model: "test-model",
      prompt: "use a deferred tool",
      tools: catalog.listTools(),
      toolCatalog: catalog,
      authorize: async () => ({ behavior: "allow" }),
    });

    expect(result.stopReason).toBe("end-turn");
    expect(transport.requests[0]?.tools.map((tool) => tool.name)).toEqual(["read", "tool_search"]);
    expect(transport.requests[1]?.tools.map((tool) => tool.name)).toEqual(["read", "write", "tool_search"]);
    expect(transport.requests[1]?.tools.find((tool) => tool.name === "write")?.inputSchema).toEqual(
      write.inputSchema,
    );
  });
});
