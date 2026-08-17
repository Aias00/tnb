import { describe, expect, test } from "bun:test";

import {
  expandPromptReferences,
  formatImageRef,
  formatPastedTextRef,
  getPastedTextRefNumLines,
  parsePromptReferences,
} from "../../src/ui/prompt-input/references";

describe("prompt references", () => {
  test("uses the reference newline-count format", () => {
    expect(formatPastedTextRef(1, getPastedTextRefNumLines("line1\nline2\nline3"))).toBe("[Pasted text #1 +2 lines]");
    expect(formatPastedTextRef(2, getPastedTextRefNumLines("single"))).toBe("[Pasted text #2]");
    expect(formatImageRef(3)).toBe("[Image #3]");
  });

  test("parses typed atomic ranges and ignores malformed ids", () => {
    const value = "a [Image #3] b [Pasted text #1 +2 lines]";
    expect(parsePromptReferences(value)).toEqual([
      { id: 3, type: "image", start: 2, end: 12, text: "[Image #3]" },
      { id: 1, type: "text", start: 15, end: value.length, text: "[Pasted text #1 +2 lines]" },
    ]);
    expect(parsePromptReferences("[Image #0] [Pasted text #x]")).toEqual([]);
  });

  test("expands only matching text records and returns referenced images", () => {
    const result = expandPromptReferences(
      "review [Pasted text #2 +1 lines] [Image #1] [Image #99]",
      {
        1: { id: 1, type: "image", path: "screen.png", mediaType: "image/png" },
        2: { id: 2, type: "text", content: "first\nsecond [Image #1]" },
      },
    );
    expect(result.expanded).toBe("review first\nsecond [Image #1] [Image #1] [Image #99]");
    expect(result.images.map(({ id }) => id)).toEqual([1]);
  });
});
