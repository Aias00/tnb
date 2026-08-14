import { describe, expect, test } from "bun:test";

import { defineTool } from "../../src/core/tool";

describe("tool definition", () => {
  test("uses conservative defaults for unspecified execution policy", () => {
    const tool = defineTool({
      name: "custom",
      description: "test",
      inputSchema: { type: "object" },
      validate: (input) => input,
      execute: async () => "ok",
    });

    expect(tool.access).toBe("unknown");
    expect(tool.isReadOnly({})).toBe(false);
    expect(tool.isConcurrencySafe({})).toBe(false);
  });
});
