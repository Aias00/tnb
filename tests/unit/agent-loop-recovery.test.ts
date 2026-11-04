import { describe, expect, test } from "bun:test";

import { runAgentLoop } from "../../src/core/agent-loop";
import type { ModelRequest, ModelTransport } from "../../src/providers/types";
import { executeTool } from "../../src/core/tool-runtime";
import { defineTool, type ToolCallIdentity } from "../../src/core/tool";

describe("Agent loop recovery history", () => {
  test("binds the original call identity and history scope before authorization, including replay", async () => {
    const identities: ToolCallIdentity[] = [];
    const bound = defineTool({ name: "control", description: "Fixture", inputSchema: {}, access: "read", validate: (value) => value, execute: async () => "done" });
    const tool = { ...bound, bindExecution(identity?: ToolCallIdentity) { identities.push(identity!); return bound; } };
    for (const scope of ["first-message", "first-message", "later-identical-message"]) {
      await executeTool({ type: "tool-use", id: "same-provider-id", name: "control", input: {} }, {
        model: "fixture", prompt: "", transport: { async *stream() { throw new Error("No model request expected"); } }, tools: [tool],
        authorize: async (candidate) => { expect(candidate).toBe(bound); return { behavior: "allow" }; },
      }, new AbortController().signal, scope);
    }
    expect(identities).toEqual(["first-message", "first-message", "later-identical-message"].map((scope) => ({ toolUseId: "same-provider-id", scope })));
  });
  test("merges a recovery prompt into a trailing user turn before provider replay", async () => {
    let request: ModelRequest | undefined;
    const transport: ModelTransport = {
      async *stream(value) {
        request = value;
        yield { type: "text", index: 0, text: "resumed" } as const;
        yield { type: "response-end", reason: "end-turn" } as const;
      },
    };
    await runAgentLoop({
      transport,
      model: "test-model",
      prompt: "resume safely",
      messages: [{ role: "user", content: [{ type: "text", text: "original task" }] }],
      tools: [],
      authorize: async () => ({ behavior: "allow" }),
    });
    expect(request?.messages).toEqual([{ role: "user", content: [
      { type: "text", text: "original task" },
      { type: "text", text: "resume safely" },
    ] }]);
  });
});
