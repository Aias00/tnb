import stripAnsi from "strip-ansi";

import { stringWidth } from "./ink/stringWidth";
import {
  Cursor,
  getLastKill,
  pushToKillRing,
  recordYank,
  resetKillAccumulation,
  resetYankState,
  updateYankLength,
  yankPop,
} from "./input/cursor";
import { normalizedGraphemeOffset } from "./input/intl";

export type InputKey =
  | { name: "text"; text: string; columns?: number }
  | {
      name:
        | "left" | "right" | "up" | "down" | "backspace" | "delete"
        | "home" | "end" | "word-left" | "word-right" | "delete-to-end"
        | "kill-line-start" | "kill-line-end" | "kill-word" | "yank" | "yank-pop";
      columns?: number;
    }
  | { name: "enter"; shift?: boolean; columns?: number };

export type InputBuffer = {
  value: string;
  cursor: number;
  history?: string[];
  historyIndex?: number;
  historyDraft?: { value: string; cursor: number; pastedContents?: Record<number, string> };
  pastedContents?: Record<number, string>;
  nextPasteId?: number;
  submitted?: string;
};

export const PASTE_THRESHOLD = 800;
const PASTE_VISIBLE_LINE_LIMIT = 2;

export type InputHistorySearch = {
  query: string;
  original: InputBuffer;
  matchIndex?: number;
};

export function createInputBuffer(value = "", history: string[] = []): InputBuffer {
  return {
    value,
    cursor: value.length,
    ...(history.length ? { history: [...history], historyIndex: history.length } : {}),
  };
}

export function applyInputKey(buffer: InputBuffer, key: InputKey): InputBuffer {
  const current = clearSubmission(buffer);
  const cursor = createBufferCursor(current, key.columns);
  if (key.name === "text") {
    const text = normalizeTerminalInput(key.text);
    const paste = collapsePastedText(current, text);
    resetKillAccumulation();
    resetYankState();
    return updateFromCursor(paste.buffer, createBufferCursor(paste.buffer, key.columns).insert(paste.text));
  }
  if (key.name === "left") return moveWithCursor(current, cursor.left());
  if (key.name === "right") return moveWithCursor(current, cursor.right());
  if (key.name === "home") return moveWithCursor(current, cursor.startOfLine());
  if (key.name === "end") return moveWithCursor(current, cursor.endOfLine());
  if (key.name === "word-left") return moveWithCursor(current, cursor.prevWord());
  if (key.name === "word-right") return moveWithCursor(current, cursor.nextWord());
  if (key.name === "backspace") return editWithCursor(current, cursor.backspace());
  if (key.name === "delete") return editWithCursor(current, cursor.del());
  if (key.name === "delete-to-end") {
    return editWithCursor(current, cursor.deleteToLineEnd().cursor);
  }
  if (key.name === "kill-line-end") {
    const result = cursor.deleteToLineEnd();
    pushToKillRing(result.killed, "append");
    return updateFromCursor(current, result.cursor);
  }
  if (key.name === "kill-line-start") {
    const result = cursor.deleteToLineStart();
    pushToKillRing(result.killed, "prepend");
    return updateFromCursor(current, result.cursor);
  }
  if (key.name === "kill-word") {
    const result = cursor.deleteWordBefore();
    pushToKillRing(result.killed, "prepend");
    return updateFromCursor(current, result.cursor);
  }
  if (key.name === "yank") {
    const text = getLastKill();
    if (!text) return current;
    const next = cursor.insert(text);
    recordYank(cursor.offset, text.length);
    return updateFromCursor(current, next);
  }
  if (key.name === "yank-pop") {
    const result = yankPop();
    if (!result) return current;
    const text = `${cursor.text.slice(0, result.start)}${result.text}${cursor.text.slice(result.start + result.length)}`;
    updateYankLength(result.text.length);
    return updateFromCursor(current, Cursor.fromText(text, cursor.measuredText.columns + 1, result.start + result.text.length));
  }
  if (key.name === "up" || key.name === "down") {
    resetKillAccumulation();
    resetYankState();
    const visual = key.name === "up" ? cursor.up() : cursor.down();
    if (!visual.equals(cursor)) return updateCursorPosition(current, visual);
    if (current.historyDraft || (current.history?.length && !current.value.includes("\n"))) {
      return navigateHistory(current, key.name);
    }
    const logical = key.name === "up" ? cursor.upLogicalLine() : cursor.downLogicalLine();
    if (!logical.equals(cursor)) return updateCursorPosition(current, logical);
    return navigateHistory(current, key.name);
  }
  if (key.name === "enter") {
    if (key.shift) return applyInputKey(current, { name: "text", text: "\n", columns: key.columns });
    const submitted = expandPastedText(current.value, current.pastedContents).trim();
    return submitted ? { ...current, submitted } : current;
  }
  return current;
}

export function searchInputHistory(
  history: readonly string[],
  query: string,
  beforeIndex = history.length,
): { value: string; index: number } | undefined {
  if (!history.length) return undefined;
  const normalized = query.toLocaleLowerCase();
  for (let index = Math.min(beforeIndex, history.length) - 1; index >= 0; index -= 1) {
    const value = history[index]!;
    if (!normalized || value.toLocaleLowerCase().includes(normalized)) return { value, index };
  }
  return undefined;
}

function clearSubmission(buffer: InputBuffer): InputBuffer {
  if (buffer.submitted === undefined) return buffer;
  const { submitted: _submitted, ...rest } = buffer;
  return rest;
}

function updateValue(buffer: InputBuffer, value: string, cursor: number): InputBuffer {
  const { historyDraft: _historyDraft, ...current } = buffer;
  const wasBrowsing = buffer.historyDraft !== undefined;
  return {
    ...current,
    value,
    cursor,
    ...(wasBrowsing ? { pastedContents: undefined, nextPasteId: undefined } : {}),
    ...(current.history?.length ? { historyIndex: current.history.length } : {}),
  };
}

function createBufferCursor(buffer: InputBuffer, columns?: number): Cursor {
  const normalizedColumns = Number.isFinite(columns) && Number(columns) >= 2
    ? Math.floor(Number(columns))
    : Math.max(2, stringWidth(buffer.value) + 2);
  const measured = Cursor.fromText(buffer.value, normalizedColumns, 0);
  const offset = normalizedGraphemeOffset(buffer.value, buffer.cursor);
  return new Cursor(measured.measuredText, offset);
}

function moveWithCursor(buffer: InputBuffer, cursor: Cursor): InputBuffer {
  resetKillAccumulation();
  resetYankState();
  return updateCursorPosition(buffer, cursor);
}

function editWithCursor(buffer: InputBuffer, cursor: Cursor): InputBuffer {
  resetKillAccumulation();
  resetYankState();
  return updateFromCursor(buffer, cursor);
}

function updateCursorPosition(buffer: InputBuffer, cursor: Cursor): InputBuffer {
  return { ...buffer, value: cursor.text, cursor: cursor.offset };
}

function updateFromCursor(buffer: InputBuffer, cursor: Cursor): InputBuffer {
  return updateValue(buffer, cursor.text, cursor.offset);
}

function navigateHistory(buffer: InputBuffer, direction: "up" | "down"): InputBuffer {
  const history = buffer.history;
  const isBrowsing = buffer.historyIndex !== undefined && buffer.historyIndex < (history?.length ?? 0);
  if (!history?.length) return buffer;
  const current = buffer.historyIndex ?? history.length;
  const index = direction === "up"
    ? Math.max(0, current - 1)
    : Math.min(history.length, current + 1);
  if (index === current) return buffer;
  if (direction === "up") {
    const draft = isBrowsing ? buffer.historyDraft : {
      value: buffer.value,
      cursor: buffer.cursor,
      ...(buffer.pastedContents ? { pastedContents: structuredClone(buffer.pastedContents) } : {}),
    };
    const value = history[index]!;
    return {
      ...buffer,
      historyIndex: index,
      historyDraft: draft,
      value,
      cursor: 0,
      pastedContents: undefined,
      nextPasteId: undefined,
    };
  }
  if (index === history.length) {
    const draft = buffer.historyDraft ?? { value: "", cursor: 0 };
    const { historyDraft: _historyDraft, ...rest } = buffer;
    return {
      ...rest,
      historyIndex: index,
      value: draft.value,
      cursor: draft.cursor,
      pastedContents: draft.pastedContents,
      nextPasteId: nextPasteId(draft.pastedContents),
    };
  }
  const value = history[index]!;
  return { ...buffer, historyIndex: index, value, cursor: value.length };
}

export function normalizeTerminalInput(input: string): string {
  return stripAnsi(input)
    .replace(/(?<=[^\\\r\n])\r$/, "")
    .replace(/\r/g, "\n")
    .replaceAll("\t", "    ");
}

export function collapsePastedText(buffer: InputBuffer, text: string): { buffer: InputBuffer; text: string } {
  const lineCount = text ? text.split("\n").length : 0;
  if (text.length <= PASTE_THRESHOLD && lineCount <= PASTE_VISIBLE_LINE_LIMIT) return { buffer, text };
  const id = buffer.nextPasteId ?? nextPasteId(buffer.pastedContents);
  return {
    buffer: {
      ...buffer,
      pastedContents: { ...buffer.pastedContents, [id]: text },
      nextPasteId: id + 1,
    },
    text: `[Pasted text #${id} +${lineCount} lines]`,
  };
}

export function expandPastedText(value: string, pastedContents?: Record<number, string>): string {
  if (!pastedContents) return value;
  let expanded = value;
  for (const [id, content] of Object.entries(pastedContents)) {
    expanded = expanded.replace(new RegExp(`\\[Pasted text #${id} \\+\\d+ lines\\]`, "g"), content);
  }
  return expanded;
}

function nextPasteId(contents?: Record<number, string>): number {
  const ids = Object.keys(contents ?? {}).map(Number).filter(Number.isSafeInteger);
  return ids.length ? Math.max(...ids) + 1 : 1;
}
