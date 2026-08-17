import { describe, expect, test } from "bun:test";
import { buildPromptLayout } from "../../src/ui/input/prompt-layout";
import { promptOffsetFromMouse } from "../../src/ui/prompt-input/mouse";

describe("prompt mouse mapping", () => {
  test("maps wrapped cells and snaps inside atomic tokens", () => {
    const text = "ab [Image #1] 界cd";
    const layout = buildPromptLayout({ text, offset: 0, terminalColumns: 16, prefixColumns: 4 });
    const inside = promptOffsetFromMouse({ text, layout, row: 0, column: 7 });
    expect([3, 13]).toContain(inside);
    expect(promptOffsetFromMouse({ text, layout, row: 10, column: 99 })).toBeLessThanOrEqual(text.length);
  });
});
