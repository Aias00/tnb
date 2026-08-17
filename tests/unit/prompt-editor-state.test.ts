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
