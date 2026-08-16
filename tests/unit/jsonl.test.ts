import { describe, expect, test } from "bun:test";

import { parseJsonl } from "../../src/utils/jsonl";

describe("JSONL recovery parser", () => {
  test("skips malformed and truncated records while preserving valid records", () => {
    const input = '\ufeff{"id":1}\nnot-json\n{"id":2}\n{"id":';
    expect(parseJsonl<{ id: number }>(input)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("parses Buffer input with a UTF-8 BOM", () => {
    expect(parseJsonl<{ id: number }>(Buffer.from('\ufeff{"id":3}\n'))).toEqual([{ id: 3 }]);
  });
});
