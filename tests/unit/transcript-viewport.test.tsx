import { describe, expect, test } from "bun:test";
import { applyViewportCommand } from "../../src/ui/transcript/TranscriptViewport";
import { createViewportState, updateContentHeight } from "../../src/ui/transcript/viewport-state";

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
});
