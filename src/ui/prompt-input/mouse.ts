import { Cursor } from "../input/cursor";
import type { PromptLayout } from "../input/prompt-layout";
import { atomicReferenceAt } from "./references";

export function promptOffsetFromMouse(options: {
  text: string;
  layout: PromptLayout;
  row: number;
  column: number;
}): number {
  const cursor = Cursor.fromText(options.text, options.layout.contentColumns, 0);
  const line = Math.max(options.layout.viewportStartLine, Math.min(
    options.layout.viewportEndLine - 1,
    options.layout.viewportStartLine + Math.max(0, options.row),
  ));
  const offset = cursor.measuredText.getOffsetFromPosition({ line, column: Math.max(0, options.column) });
  const reference = atomicReferenceAt(options.text, offset);
  if (!reference) return offset;
  return offset - reference.start < reference.end - offset ? reference.start : reference.end;
}
