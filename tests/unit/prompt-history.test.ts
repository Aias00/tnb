import { describe, expect, test } from "bun:test";
import { createPromptEditorState } from "../../src/ui/prompt-input/editor-state";
import { PromptHistoryNavigator } from "../../src/ui/prompt-input/history";

describe("structured prompt history", () => {
  test("preserves a complete draft and referenced content", () => {
    const history = new PromptHistoryNavigator([{
      display: "review [Image #1]",
      mode: "prompt",
      pastedContents: { 1: { id: 1, type: "image", path: "screen.png", mediaType: "image/png" } },
    }]);
    const draft = { ...createPromptEditorState("draft"), cursorOffset: 2 };
    const recalled = history.up(draft);
    expect(recalled.value).toBe("review [Image #1]");
    expect(recalled.pastedContents[1]).toMatchObject({ path: "screen.png" });
    expect(history.down(recalled)).toEqual(draft);
  });
});
