import { describe, expect, test } from "bun:test";

import {
  buildPromptLayout,
  promptContentColumns,
} from "../../src/ui/input/prompt-layout";

describe("prompt layout", () => {
  test("uses one wrapped layout for rows and cursor position", () => {
    const layout = buildPromptLayout({
      text: "abcdefghij",
      offset: 7,
      terminalColumns: 10,
      prefixColumns: 4,
    });
    expect(layout.contentColumns).toBe(6);
    expect(layout.totalWrappedLines).toBe(2);
    expect(layout.cursorLine).toBe(1);
    expect(layout.promptRowsUsed).toBe(layout.totalWrappedLines + 2);
  });

  test("keeps CJK and emoji cursor cells aligned after resize", () => {
    const text = "界界👨‍👩‍👧‍👦abc";
    const wide = buildPromptLayout({ text, offset: 2, terminalColumns: 12, prefixColumns: 4 });
    const narrow = buildPromptLayout({ text, offset: 2, terminalColumns: 9, prefixColumns: 4 });
    expect(narrow.totalWrappedLines).toBeGreaterThanOrEqual(wide.totalWrappedLines);
    expect(wide.cursorColumn).toBe(4);
  });

  test("derives the exact content width from prompt chrome and mode", () => {
    expect(promptContentColumns(80)).toBe(74);
    expect(promptContentColumns(80, "NORMAL")).toBe(65);
    expect(promptContentColumns(1, "INSERT")).toBe(2);
  });

  test("snaps restored NFD offsets before normalization", () => {
    const layout = buildPromptLayout({
      text: "e\u0301x",
      offset: 1,
      terminalColumns: 20,
      prefixColumns: 4,
    });
    expect(layout.cursorColumn).toBe(0);
    expect(layout.visibleText).toContain("é");
  });
});
