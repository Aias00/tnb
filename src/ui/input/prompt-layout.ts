import { stringWidth } from "../ink/stringWidth";
import { Cursor } from "./cursor";
import { normalizedGraphemeOffset } from "./intl";

export type PromptLayout = {
  contentColumns: number;
  wrappedLines: string[];
  viewportStartLine: number;
  viewportEndLine: number;
  cursorLine: number;
  cursorColumn: number;
  visibleText: string;
  totalWrappedLines: number;
  promptRowsUsed: number;
};

export function promptContentColumns(terminalColumns: number, mode?: string): number {
  const borderAndPaddingColumns = 4;
  const pointerColumns = 2;
  const modeColumns = mode ? stringWidth(`[${mode}] `) : 0;
  return Math.max(2, terminalColumns - borderAndPaddingColumns - pointerColumns - modeColumns);
}

export function buildPromptLayout(options: {
  text: string;
  offset: number;
  terminalColumns: number;
  prefixColumns: number;
  maxVisibleLines?: number;
  inverse?: (text: string) => string;
}): PromptLayout {
  const contentColumns = Math.max(2, options.terminalColumns - options.prefixColumns);
  const measured = Cursor.fromText(options.text, contentColumns, 0);
  const offset = normalizedGraphemeOffset(options.text, options.offset);
  const cursor = new Cursor(measured.measuredText, offset);
  const position = cursor.getPosition();
  const wrappedLines = cursor.measuredText.getWrappedText();
  const viewportStartLine = cursor.getViewportStartLine(options.maxVisibleLines);
  const viewportEndLine = options.maxVisibleLines
    ? Math.min(wrappedLines.length, viewportStartLine + options.maxVisibleLines)
    : wrappedLines.length;
  const visibleRows = Math.max(1, viewportEndLine - viewportStartLine);
  return {
    contentColumns,
    wrappedLines,
    viewportStartLine,
    viewportEndLine,
    cursorLine: position.line,
    cursorColumn: position.column,
    visibleText: cursor.render(
      " ",
      "",
      options.inverse ?? ((text) => `\u001B[7m${text}\u001B[27m`),
      undefined,
      options.maxVisibleLines,
    ),
    totalWrappedLines: wrappedLines.length,
    promptRowsUsed: visibleRows + 2,
  };
}
