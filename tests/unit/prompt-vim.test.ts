import { describe, expect, test } from "bun:test";
import { createPromptEditorState } from "../../src/ui/prompt-input/editor-state";
import { VimInputController } from "../../src/ui/prompt-input/use-vim-input";
import type { PromptEditorState } from "../../src/ui/prompt-input/types";

describe("complete Vim prompt controller", () => {
  test("executes operator motions and counts", () => {
    const vim = new VimInputController();
    let state: PromptEditorState = { ...createPromptEditorState("one two three"), cursorOffset: 0, vimMode: "NORMAL" };
    state = vim.handleNormal(state, "d", 80);
    state = vim.handleNormal(state, "w", 80);
    expect(state.value).toBe("two three");
    state = vim.handleNormal(state, "2", 80);
    state = vim.handleNormal(state, "x", 80);
    expect(state.value).toBe("o three");
  });

  test("supports text objects and dot repeat", () => {
    const vim = new VimInputController();
    let state: PromptEditorState = { ...createPromptEditorState("alpha beta gamma"), cursorOffset: 6, vimMode: "NORMAL" };
    for (const key of ["d", "i", "w"]) state = vim.handleNormal(state, key, 80);
    expect(state.value).toBe("alpha  gamma");
    state = { ...state, cursorOffset: 7 };
    state = vim.handleNormal(state, ".", 80);
    expect(state.value.length).toBeLessThan("alpha  gamma".length);
  });
});
