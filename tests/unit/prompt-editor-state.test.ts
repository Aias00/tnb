import { describe, expect, test } from "bun:test";
import { applyPromptEditorAction, createPromptEditorState } from "../../src/ui/prompt-input/editor-state";
import { PromptStash, PromptUndoBuffer } from "../../src/ui/prompt-input/undo";

describe("prompt editor state", () => {
  test("treats pasted text and images as atomic tokens", () => {
    let state = applyPromptEditorAction(createPromptEditorState(), { type: "paste-text", text: "a\nb\nc\nd", columns: 40 });
    expect(state.value).toBe("[Pasted text #1 +3 lines]");
    state = applyPromptEditorAction(state, { type: "paste-image", path: "screen.png", mediaType: "image/png", columns: 40 });
    expect(state.value).toContain("[Image #2]");
    state = applyPromptEditorAction(state, { type: "backspace", columns: 40 });
    expect(state.value).not.toContain("[Image #2]");
    expect(state.pastedContents[2]).toBeUndefined();
  });

  test("restores full undo and single-slot stash state", () => {
    const undo = new PromptUndoBuffer();
    const first = createPromptEditorState("first");
    const second = { ...createPromptEditorState("second"), vimMode: "NORMAL" as const, nextPasteId: 4 };
    undo.push(first, true, 1);
    undo.push(second, true, 2);
    expect(undo.undo()).toEqual(first);
    const stash = new PromptStash();
    expect(stash.stash(second)).toBeUndefined();
    expect(stash.hasValue()).toBe(true);
    expect(stash.stash(createPromptEditorState())).toEqual(second);
  });
});

test("real prompt editor supports cut/yank and restores whole pasted references", () => {
  const { clearKillRing } = require("../../src/ui/input/cursor");
  const { expandPromptReferences } = require("../../src/ui/prompt-input/references");
  clearKillRing();
  let state = createPromptEditorState("hello world");
  state = applyPromptEditorAction(state, { type: "kill-word", columns: 80 });
  expect(state.value).toBe("hello ");
  state = applyPromptEditorAction(state, { type: "yank", columns: 80 });
  expect(state.value).toBe("hello world");
  state = applyPromptEditorAction({ ...state, cursorOffset: 5 }, { type: "kill-line-end", columns: 80 });
  expect(state.value).toBe("hello");
  state = applyPromptEditorAction(state, { type: "yank", columns: 80 });
  expect(state.value).toBe("hello world");

  state = applyPromptEditorAction(createPromptEditorState(), { type: "paste-text", text: "alpha\nbeta\ngamma\ndelta" });
  clearKillRing();
  state = applyPromptEditorAction(state, { type: "kill-word", columns: 80 });
  expect(state.value).toBe("");
  state = applyPromptEditorAction(state, { type: "yank", columns: 80 });
  expect(expandPromptReferences(state.value, state.pastedContents).expanded).toBe("alpha\nbeta\ngamma\ndelta");
});


test("text-only cut shortcuts keep image attachments intact", () => {
  const state = applyPromptEditorAction(createPromptEditorState(), { type: "paste-image", path: "screenshot.png", mediaType: "image/png" });
  const cut = applyPromptEditorAction(state, { type: "kill-word", columns: 80 });
  expect(cut.value).toBe(state.value);
  expect(cut.pastedContents).toEqual(state.pastedContents);
});
