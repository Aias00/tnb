import { describe, expect, test } from "bun:test";
import { mapTranscriptInput } from "../../src/ui/transcript/input";

const detached = { scrollTop: 10, viewportHeight: 5, contentHeight: 30 };

describe("transcript input mapping", () => {
  test("maps page, shift aliases, and top/bottom", () => {
    expect(mapTranscriptInput("", { pageUp: true }, detached).command).toBe("page-up");
    expect(mapTranscriptInput("", { pageDown: true }, detached).command).toBe("page-down");
    expect(mapTranscriptInput("", { shift: true, upArrow: true }, detached).command).toBe("page-up");
    expect(mapTranscriptInput("", { shift: true, downArrow: true }, detached).command).toBe("page-down");
    expect(mapTranscriptInput("", { ctrl: true, home: true }, detached).command).toBe("top");
    expect(mapTranscriptInput("", { ctrl: true, end: true }, detached).command).toBe("bottom");
  });

  test("maps half pages only when movement is possible", () => {
    expect(mapTranscriptInput("u", { ctrl: true }, detached).command).toBe("half-up");
    expect(mapTranscriptInput("d", { ctrl: true }, detached).command).toBe("half-down");
    expect(mapTranscriptInput("u", { ctrl: true }, { ...detached, scrollTop: 0 }).handled).toBe(false);
    expect(mapTranscriptInput("d", { ctrl: true }, { ...detached, scrollTop: 25 }).handled).toBe(false);
  });

  test("leaves plain arrows with the editor", () => {
    expect(mapTranscriptInput("", { upArrow: true }, detached).handled).toBe(false);
    expect(mapTranscriptInput("", { downArrow: true }, detached).handled).toBe(false);
  });
});
