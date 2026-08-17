import { Cursor } from "../input/cursor";
import { normalizedGraphemeOffset } from "../input/intl";
import { stringWidth } from "../ink/stringWidth";
import { atomicReferenceAt, formatImageRef, formatPastedTextRef, getPastedTextRefNumLines, parsePromptReferences } from "./references";
import type { PastedContent, PromptEditorState } from "./types";

export type PromptEditorAction =
  | { type: "insert"; text: string; columns?: number }
  | { type: "left" | "right" | "up" | "down" | "home" | "end" | "backspace" | "delete"; columns?: number }
  | { type: "paste-text"; text: string; threshold?: number; columns?: number }
  | { type: "paste-image"; path: string; mediaType: Extract<PastedContent, { type: "image" }>["mediaType"]; columns?: number }
  | { type: "set-mode"; mode: PromptEditorState["mode"] }
  | { type: "set-vim-mode"; mode: PromptEditorState["vimMode"] }
  | { type: "replace"; state: PromptEditorState };

export function createPromptEditorState(value = ""): PromptEditorState {
  return { value, cursorOffset: value.length, mode: "prompt", vimMode: "INSERT", pastedContents: {}, nextPasteId: 1 };
}

export function applyPromptEditorAction(state: PromptEditorState, action: PromptEditorAction): PromptEditorState {
  if (action.type === "replace") return normalizeState(action.state);
  if (action.type === "set-mode") return { ...state, mode: action.mode };
  if (action.type === "set-vim-mode") return { ...state, vimMode: action.mode };
  if (action.type === "paste-text") {
    const text = normalizeInput(action.text);
    const threshold = action.threshold ?? 800;
    if (text.length <= threshold && getPastedTextRefNumLines(text) <= 2) return insert(state, text, action.columns);
    const id = state.nextPasteId;
    const reference = formatPastedTextRef(id, getPastedTextRefNumLines(text));
    return insert({ ...state, pastedContents: { ...state.pastedContents, [id]: { id, type: "text", content: text } }, nextPasteId: id + 1 }, reference, action.columns);
  }
  if (action.type === "paste-image") {
    const id = state.nextPasteId;
    return insert({
      ...state,
      pastedContents: { ...state.pastedContents, [id]: { id, type: "image", path: action.path, mediaType: action.mediaType } },
      nextPasteId: id + 1,
    }, formatImageRef(id), action.columns);
  }
  if (action.type === "insert") return insert(state, normalizeInput(action.text), action.columns);
  const cursor = editorCursor(state, action.columns);
  if (action.type === "left") return move(state, snapAtomic(state.value, cursor.left().offset, "start"));
  if (action.type === "right") return move(state, snapAtomic(state.value, cursor.right().offset, "end"));
  if (action.type === "home") return move(state, cursor.startOfLine().offset);
  if (action.type === "end") return move(state, cursor.endOfLine().offset);
  if (action.type === "up") return move(state, snapAtomic(state.value, cursor.up().offset, "start"));
  if (action.type === "down") return move(state, snapAtomic(state.value, cursor.down().offset, "end"));
  if (action.type === "backspace") {
    const reference = parsePromptReferences(state.value).find((item) => item.end === cursor.offset);
    return reference ? removeRange(state, reference.start, reference.end) : fromCursor(state, cursor.backspace());
  }
  const reference = parsePromptReferences(state.value).find((item) => item.start === cursor.offset) ?? atomicReferenceAt(state.value, cursor.offset);
  return reference ? removeRange(state, reference.start, reference.end) : fromCursor(state, cursor.del());
}

export function pruneOrphanedPastedContents(state: PromptEditorState): PromptEditorState {
  const referenced = new Set(parsePromptReferences(state.value).map(({ id }) => id));
  const pastedContents = Object.fromEntries(Object.entries(state.pastedContents).filter(([id]) => referenced.has(Number(id))));
  return { ...state, pastedContents };
}

function insert(state: PromptEditorState, text: string, columns?: number): PromptEditorState {
  return fromCursor(state, editorCursor(state, columns).insert(text));
}

function removeRange(state: PromptEditorState, start: number, end: number): PromptEditorState {
  return pruneOrphanedPastedContents({ ...state, value: `${state.value.slice(0, start)}${state.value.slice(end)}`, cursorOffset: start });
}

function fromCursor(state: PromptEditorState, cursor: Cursor): PromptEditorState {
  return pruneOrphanedPastedContents({ ...state, value: cursor.text, cursorOffset: cursor.offset });
}

function move(state: PromptEditorState, cursorOffset: number): PromptEditorState {
  return { ...state, cursorOffset };
}

function editorCursor(state: PromptEditorState, columns?: number): Cursor {
  const width = Number.isFinite(columns) && Number(columns) >= 2 ? Math.floor(Number(columns)) : Math.max(2, stringWidth(state.value) + 2);
  const cursor = Cursor.fromText(state.value, width, 0);
  return new Cursor(cursor.measuredText, normalizedGraphemeOffset(state.value, state.cursorOffset));
}

function snapAtomic(value: string, offset: number, edge: "start" | "end"): number {
  const reference = atomicReferenceAt(value, offset);
  return reference ? reference[edge] : offset;
}

function normalizeState(state: PromptEditorState): PromptEditorState {
  const cursor = editorCursor(state);
  return pruneOrphanedPastedContents({ ...structuredClone(state), value: cursor.text, cursorOffset: cursor.offset });
}

function normalizeInput(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "\n").replaceAll("\t", "    ");
}
