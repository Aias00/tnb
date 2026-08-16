import { describe, expect, test } from "bun:test";

import {
  applyInputKey,
  collapsePastedText,
  createInputBuffer,
  expandPastedText,
  normalizeTerminalInput,
  searchInputHistory,
} from "../../src/ui/input-buffer";
import { applyInkInput, restoreInputHistory } from "../../src/ui/app";
import { sessionInputHistory } from "../../src/services/session/storage";

describe("TUI input buffer", () => {
  test("inserts text at the cursor and supports cursor-aware backspace", () => {
    let buffer = createInputBuffer("ac");
    buffer = applyInputKey(buffer, { name: "left" });
    buffer = applyInputKey(buffer, { name: "text", text: "b" });
    buffer = applyInputKey(buffer, { name: "backspace" });

    expect(buffer).toEqual({ value: "ac", cursor: 1 });
  });

  test("uses up and down for prompt history when the input is empty", () => {
    let buffer = createInputBuffer("", ["first", "second"]);
    buffer = applyInputKey(buffer, { name: "up" });
    expect(buffer.value).toBe("second");
    buffer = applyInputKey(buffer, { name: "up" });
    expect(buffer.value).toBe("first");
    buffer = applyInputKey(buffer, { name: "down" });
    expect(buffer.value).toBe("second");
  });

  test("preserves a non-empty draft while browsing history", () => {
    let buffer = createInputBuffer("unfinished draft", ["first", "second"]);
    buffer = { ...buffer, cursor: 4 };
    buffer = applyInputKey(buffer, { name: "up" });
    expect(buffer).toMatchObject({ value: "second", cursor: 0, historyIndex: 1 });
    buffer = applyInputKey(buffer, { name: "up" });
    expect(buffer.value).toBe("first");
    buffer = applyInputKey(buffer, { name: "down" });
    buffer = applyInputKey(buffer, { name: "down" });
    expect(buffer).toMatchObject({ value: "unfinished draft", cursor: 4, historyIndex: 2 });
    expect(buffer.historyDraft).toBeUndefined();
  });

  test("leaves history browsing when a recalled prompt is edited", () => {
    let buffer = applyInputKey(createInputBuffer("", ["first", "second"]), { name: "up" });
    buffer = applyInputKey(buffer, { name: "text", text: " changed" });
    expect(buffer).toMatchObject({ value: " changedsecond", historyIndex: 2 });
    expect(buffer.historyDraft).toBeUndefined();
  });

  test("normalizes terminal paste input before inserting it", () => {
    expect(normalizeTerminalInput("\u001B[31mred\u001B[0m\rnext\tvalue")).toBe("red\nnext    value");
    expect(normalizeTerminalInput("typed\r")).toBe("typed");
    expect(normalizeTerminalInput("\\\r")).toBe("\\\n");
  });

  test("collapses a large paste for display and expands it for submission", () => {
    const content = Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n");
    const collapsed = collapsePastedText(createInputBuffer("prefix "), content);
    expect(collapsed.text).toBe("[Pasted text #1 +8 lines]");
    expect(expandPastedText(collapsed.text, collapsed.buffer.pastedContents)).toBe(content);

    let buffer = applyInputKey(createInputBuffer("prefix "), { name: "text", text: content });
    expect(buffer.value).toBe("prefix [Pasted text #1 +8 lines]");
    buffer = applyInputKey(buffer, { name: "enter" });
    expect(buffer.submitted).toBe(`prefix ${content}`);
  });

  test("restores collapsed paste contents with a history draft", () => {
    const content = "a\nb\nc";
    let buffer = applyInputKey(createInputBuffer("", ["older"]), { name: "text", text: content });
    const draftValue = buffer.value;
    buffer = applyInputKey(buffer, { name: "up" });
    expect(buffer.value).toBe("older");
    buffer = applyInputKey(buffer, { name: "down" });
    expect(buffer.value).toBe(draftValue);
    expect(applyInputKey(buffer, { name: "enter" }).submitted).toBe(content);
  });

  test("moves across visual input lines before using prompt history", () => {
    let buffer = createInputBuffer("wide line\nshort\nlast", ["older prompt"]);
    buffer = { ...buffer, cursor: 7 };
    buffer = applyInputKey(buffer, { name: "down" });
    expect(buffer.cursor).toBe(15);
    buffer = applyInputKey(buffer, { name: "down" });
    expect(buffer.cursor).toBe(20);
    buffer = applyInputKey(buffer, { name: "up" });
    expect(buffer.cursor).toBe(14);
    expect(buffer.value).toBe("wide line\nshort\nlast");
  });

  test("reverse-searches prompt history from newest to oldest", () => {
    const history = ["inspect provider", "run tests", "fix provider usage"];
    expect(searchInputHistory(history, "provider")).toEqual({ value: "fix provider usage", index: 2 });
    expect(searchInputHistory(history, "provider", 2)).toEqual({ value: "inspect provider", index: 0 });
    expect(searchInputHistory(history, "missing")).toBeUndefined();
  });

  test("restores resumed-session prompts for history navigation", () => {
    const history = sessionInputHistory([
      { role: "user", content: [{ type: "text", text: "first\nrequest" }] },
      { role: "assistant", content: [{ type: "tool-use", id: "tool-1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool-result", toolUseId: "tool-1", content: "result", isError: false }] },
      { role: "user", content: [{ type: "text", text: "latest request" }] },
    ]);
    const restored = restoreInputHistory(history);

    expect(restored.history).toEqual(["first\nrequest", "latest request"]);
    expect(applyInputKey(restored.buffer, { name: "up" }).value).toBe("latest request");
  });

  test("submits on enter and inserts a newline on shift-enter", () => {
    const buffer = createInputBuffer("line one");
    expect(applyInputKey(buffer, { name: "enter", shift: true }).value).toBe(
      "line one\n",
    );
    expect(applyInputKey(buffer, { name: "enter" }).submitted).toBe("line one");
  });

  test("supports Vim-style line and word motions plus delete-to-end", () => {
    let buffer = createInputBuffer("one two\nthree four");
    buffer = applyInputKey(buffer, { name: "word-left" });
    expect(buffer.cursor).toBe(14);
    buffer = applyInputKey(buffer, { name: "home" });
    expect(buffer.cursor).toBe(8);
    buffer = applyInputKey(buffer, { name: "word-right" });
    expect(buffer.cursor).toBe(14);
    buffer = applyInputKey(buffer, { name: "delete-to-end" });
    expect(buffer).toEqual({ value: "one two\nthree ", cursor: 14 });
  });

  test("treats the macOS DEL byte as Backspace and keeps Ctrl+D as forward delete", () => {
    const baseKey = {
      upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
      pageDown: false, pageUp: false, home: false, end: false, return: false,
      escape: false, ctrl: false, shift: false, tab: false, backspace: false,
      delete: false, meta: false, super: false, hyper: false, capsLock: false,
      numLock: false,
    };
    expect(applyInkInput(createInputBuffer("abc"), "", { ...baseKey, delete: true }).value).toBe("ab");
    const middle = applyInputKey(createInputBuffer("abc"), { name: "left" });
    expect(applyInkInput(middle, "d", { ...baseKey, ctrl: true }).value).toBe("ab");
  });
});
