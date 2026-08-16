import stripAnsi from "strip-ansi";

export type InputKey =
  | { name: "text"; text: string }
  | { name: "left" | "right" | "up" | "down" | "backspace" | "delete" }
  | { name: "home" | "end" | "word-left" | "word-right" | "delete-to-end" }
  | { name: "enter"; shift?: boolean };

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
  if (key.name === "text") {
    const text = normalizeTerminalInput(key.text);
    const paste = collapsePastedText(current, text);
    return updateValue(
      paste.buffer,
      `${current.value.slice(0, current.cursor)}${paste.text}${current.value.slice(current.cursor)}`,
      current.cursor + paste.text.length,
    );
  }
  if (key.name === "left") return { ...current, cursor: Math.max(0, current.cursor - 1) };
  if (key.name === "home") return { ...current, cursor: lineStart(current.value, current.cursor) };
  if (key.name === "end") return { ...current, cursor: lineEnd(current.value, current.cursor) };
  if (key.name === "word-left") return { ...current, cursor: previousWord(current.value, current.cursor) };
  if (key.name === "word-right") return { ...current, cursor: nextWord(current.value, current.cursor) };
  if (key.name === "right") {
    return { ...current, cursor: Math.min(current.value.length, current.cursor + 1) };
  }
  if (key.name === "backspace") {
    if (current.cursor === 0) return current;
    return updateValue(
      current,
      `${current.value.slice(0, current.cursor - 1)}${current.value.slice(current.cursor)}`,
      current.cursor - 1,
    );
  }
  if (key.name === "delete") {
    if (current.cursor === current.value.length) return current;
    return updateValue(
      current,
      `${current.value.slice(0, current.cursor)}${current.value.slice(current.cursor + 1)}`,
      current.cursor,
    );
  }
  if (key.name === "delete-to-end") {
    const end = lineEnd(current.value, current.cursor);
    return updateValue(
      current,
      `${current.value.slice(0, current.cursor)}${current.value.slice(end)}`,
      current.cursor,
    );
  }
  if (key.name === "up" || key.name === "down") {
    const cursor = moveVertical(current.value, current.cursor, key.name);
    if (cursor !== current.cursor) return { ...current, cursor };
    return navigateHistory(current, key.name);
  }
  if (key.name === "enter") {
    if (key.shift) return applyInputKey(current, { name: "text", text: "\n" });
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

function lineStart(value: string, cursor: number): number {
  return value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
}

function lineEnd(value: string, cursor: number): number {
  const end = value.indexOf("\n", cursor);
  return end === -1 ? value.length : end;
}

function moveVertical(value: string, cursor: number, direction: "up" | "down"): number {
  const start = lineStart(value, cursor);
  const column = cursor - start;
  if (direction === "up") {
    if (start === 0) return cursor;
    const previousEnd = start - 1;
    const previousStart = lineStart(value, previousEnd);
    return Math.min(previousStart + column, previousEnd);
  }
  const end = lineEnd(value, cursor);
  if (end === value.length) return cursor;
  const nextStart = end + 1;
  return Math.min(nextStart + column, lineEnd(value, nextStart));
}

function previousWord(value: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && /\s/.test(value[index - 1]!)) index -= 1;
  while (index > 0 && !/\s/.test(value[index - 1]!)) index -= 1;
  return index;
}

function nextWord(value: string, cursor: number): number {
  let index = cursor;
  while (index < value.length && !/\s/.test(value[index]!)) index += 1;
  while (index < value.length && /\s/.test(value[index]!)) index += 1;
  return index;
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
