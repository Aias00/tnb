import { describe, expect, test } from "bun:test";

import {
  createStructuredOutputTool,
  parseStructuredOutputSchema,
} from "../../src/tools/structured-output";

describe("structured output tool", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["name", "score"],
    properties: {
      name: { type: "string", minLength: 1 },
      score: { type: "integer", minimum: 0, maximum: 10 },
      tags: { type: "array", items: { type: "string" } },
    },
  } as const;

  test("uses the caller schema as the provider-facing tool schema and captures valid output", async () => {
    let captured: unknown;
    const tool = createStructuredOutputTool(schema, (value) => void (captured = value));
    const input = { name: "tnb", score: 10, tags: ["cli"] };

    expect(tool.inputSchema).toBe(schema);
    const validated = tool.validate(input);
    await tool.execute(validated, new AbortController().signal);
    expect(captured).toEqual(input);
  });

  test("rejects schema mismatches and malformed root schemas", () => {
    const tool = createStructuredOutputTool(schema, () => undefined);
    expect(() => tool.validate({ name: "", score: 2.5, extra: true })).toThrow();
    expect(() => parseStructuredOutputSchema("not json")).toThrow("valid JSON");
    expect(() => parseStructuredOutputSchema('{"type":"string"}')).toThrow("root type must be object");
  });
});
