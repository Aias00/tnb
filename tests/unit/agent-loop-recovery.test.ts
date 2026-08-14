import { describe, expect, test } from "bun:test";

import { runAgentLoop } from "../../src/core/agent-loop";
import type { ModelRequest, ModelTransport } from "../../src/providers/types";

describe("Agent loop recovery history", () => {
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
