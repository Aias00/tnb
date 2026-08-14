import type { TranscriptScrollCommand } from "./TranscriptViewport";
import type { ViewportState } from "./viewport-state";

export type TranscriptInputKey = {
  pageUp?: boolean;
  pageDown?: boolean;
  wheelUp?: boolean;
  wheelDown?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  home?: boolean;
  end?: boolean;
  shift?: boolean;
  ctrl?: boolean;
};

export function mapTranscriptInput(
  input: string,
  key: TranscriptInputKey,
  viewport: Pick<ViewportState, "scrollTop" | "viewportHeight" | "contentHeight">,
): { handled: boolean; command?: TranscriptScrollCommand } {
  if (key.wheelUp) return { handled: true, command: "line-up" };
  if (key.wheelDown) return { handled: true, command: "line-down" };
  if (key.pageUp) return { handled: true, command: "page-up" };
  if (key.pageDown) return { handled: true, command: "page-down" };
  if (key.shift && key.upArrow) return { handled: true, command: "page-up" };
  if (key.shift && key.downArrow) return { handled: true, command: "page-down" };
  if (key.ctrl && key.home) return { handled: true, command: "top" };
  if (key.ctrl && key.end) return { handled: true, command: "bottom" };
  if (key.ctrl && input === "u") return viewport.scrollTop > 0
    ? { handled: true, command: "half-up" }
    : { handled: false };
  if (key.ctrl && input === "d") {
    const maximum = Math.max(0, viewport.contentHeight - viewport.viewportHeight);
    return viewport.scrollTop < maximum
      ? { handled: true, command: "half-down" }
      : { handled: false };
  }
  return { handled: false };
}
