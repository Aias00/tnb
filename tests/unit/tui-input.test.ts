import { describe, expect, test } from "bun:test";

import {
  applyInputKey,
  createInputBuffer,
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
