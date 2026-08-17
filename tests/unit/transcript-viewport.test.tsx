import { describe, expect, test } from "bun:test";
import { applyViewportCommand } from "../../src/ui/transcript/TranscriptViewport";
import { createViewportState, updateContentHeight } from "../../src/ui/transcript/viewport-state";
import { buildPromptLayout } from "../../src/ui/input/prompt-layout";
import { measureTranscriptHeight } from "../../src/ui/transcript/layout";

describe("TranscriptViewport", () => {
  test("scrolls a long row surface and repins to bottom", () => {
    let state = createViewportState(4, 20);
    state = applyViewportCommand(state, "page-up");
    expect(state).toMatchObject({ scrollTop: 12, followBottom: false });
    state = applyViewportCommand(state, "bottom");
    expect(state).toMatchObject({ scrollTop: 16, followBottom: true });
  });

  test("does not steal focus when detached content grows", () => {
    let state = applyViewportCommand(createViewportState(5, 20), "half-up");
    const scrollTop = state.scrollTop;
    state = updateContentHeight(state, 30);
    expect(state).toMatchObject({ scrollTop, followBottom: false });
  });

  test("uses the canonical prompt layout row count", () => {
    const promptLayout = buildPromptLayout({
      text: "abcdefghij",
      offset: 7,
      terminalColumns: 10,
      prefixColumns: 4,
    });
    expect(measureTranscriptHeight({
      terminalRows: 20,
      promptLayout,
      suggestionRows: 1,
    })).toBe(20 - promptLayout.promptRowsUsed - 2 - 1);
  });
});
