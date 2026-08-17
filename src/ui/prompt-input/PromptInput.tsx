import React, { useEffect, useRef } from "react";

import type { ExternalEditorResult } from "../external-editor";
import { useInput } from "../ink/index";
import { applyPromptEditorAction, createPromptEditorState } from "./editor-state";
import { PromptHistoryNavigator } from "./history";
import { expandPromptReferences } from "./references";
import type { PromptEditorState, PromptHistoryEntry, PromptInputSubmit } from "./types";
import { PromptStash, PromptUndoBuffer } from "./undo";
import { promptActionFromKey } from "./use-text-input";
import { VimInputController } from "./use-vim-input";
import { buildPromptLayout } from "../input/prompt-layout";
import { promptOffsetFromMouse } from "./mouse";

export type PromptInputControllerProps = {
  active: boolean;
  columns: number;
  value: string;
  cursorOffset: number;
  history: PromptHistoryEntry[];
  vimEnabled: boolean;
  completionActive?: boolean;
  pasteImage?(): Promise<string | undefined>;
  editInput?(value: string): Promise<ExternalEditorResult>;
  onChange(state: PromptEditorState): void;
  onSubmit(input: PromptInputSubmit): void;
  onNotice?(message: string): void;
  mousePosition?: { row: number; column: number; nonce: number };
};

export function PromptInputController(props: PromptInputControllerProps): null {
  const state = useRef<PromptEditorState>(createPromptEditorState(props.value));
  const undo = useRef(new PromptUndoBuffer());
  const stash = useRef(new PromptStash());
  const history = useRef(new PromptHistoryNavigator(props.history));
  const vim = useRef(new VimInputController());

  useEffect(() => { history.current.replace(props.history); }, [props.history]);
  useEffect(() => {
    if (state.current.value === props.value && state.current.cursorOffset === props.cursorOffset) return;
    state.current = props.value === "" && state.current.value !== ""
      ? { ...createPromptEditorState(), vimMode: state.current.vimMode }
      : { ...state.current, value: props.value, cursorOffset: props.cursorOffset };
  }, [props.cursorOffset, props.value]);
  useEffect(() => { undo.current.push(state.current, true); }, []);
  useEffect(() => {
    if (!props.mousePosition) return;
    const layout = buildPromptLayout({ text: state.current.value, offset: state.current.cursorOffset, terminalColumns: props.columns, prefixColumns: 0 });
    const cursorOffset = promptOffsetFromMouse({ text: state.current.value, layout, row: props.mousePosition.row, column: props.mousePosition.column });
    state.current = { ...state.current, cursorOffset };
    props.onChange(structuredClone(state.current));
  }, [props.mousePosition?.nonce]);

  const update = (next: PromptEditorState, structural = false) => {
    undo.current.push(next, structural);
    state.current = next;
    props.onChange(structuredClone(next));
  };

  useInput((input, key, event) => {
    if (!props.active) return;
    if (key.ctrl && input === "c") return;
    if (props.completionActive && (key.upArrow || key.downArrow || key.tab || key.return || key.escape)) return;

    if (key.ctrl && (input === "_" || input === "-" && key.shift)) {
      event.stopImmediatePropagation();
      const restored = undo.current.undo();
      if (restored) { state.current = restored; props.onChange(restored); }
      return;
    }
    if (key.ctrl && input === "s") {
      event.stopImmediatePropagation();
      const restored = stash.current.stash(state.current);
      update(restored ?? createPromptEditorState(), true);
      return;
    }
    if (key.ctrl && input === "v" && props.pasteImage) {
      event.stopImmediatePropagation();
      void props.pasteImage().then((path) => {
        if (!path) return props.onNotice?.("The clipboard does not contain an image.");
        update(applyPromptEditorAction(state.current, { type: "paste-image", path, mediaType: "image/png", columns: props.columns }), true);
      }).catch((error: unknown) => props.onNotice?.(error instanceof Error ? error.message : String(error)));
      return;
    }
    if (key.ctrl && input === "g" && props.editInput) {
      event.stopImmediatePropagation();
      const snapshot = structuredClone(state.current);
      const expanded = expandPromptReferences(snapshot.value, snapshot.pastedContents).expanded;
      void props.editInput(expanded).then((result) => {
        if (result.error) { state.current = snapshot; props.onChange(snapshot); props.onNotice?.(result.error); return; }
        if (result.content !== undefined) update({ ...createPromptEditorState(result.content), mode: snapshot.mode, vimMode: snapshot.vimMode }, true);
      }).catch((error: unknown) => { state.current = snapshot; props.onChange(snapshot); props.onNotice?.(error instanceof Error ? error.message : String(error)); });
      return;
    }
    if (key.return && !key.shift) {
      event.stopImmediatePropagation();
      const expanded = expandPromptReferences(state.current.value, state.current.pastedContents).expanded.trim();
      if (expanded) props.onSubmit({ display: state.current.value.trim(), expanded, mode: state.current.mode, pastedContents: structuredClone(state.current.pastedContents) });
      return;
    }

    if (props.vimEnabled && key.escape) {
      event.stopImmediatePropagation();
      if (state.current.vimMode === "INSERT") {
        const moved = state.current.cursorOffset > 0 ? applyPromptEditorAction(state.current, { type: "left", columns: props.columns }) : state.current;
        update({ ...moved, vimMode: "NORMAL" });
      } else vim.current.reset();
      return;
    }
    if (props.vimEnabled && state.current.vimMode === "NORMAL" && !key.ctrl && !key.meta) {
      event.stopImmediatePropagation();
      update(vim.current.handleNormal(state.current, input, props.columns, () => undo.current.undo()), true);
      return;
    }

    if (key.upArrow || key.downArrow) {
      const moved = applyPromptEditorAction(state.current, { type: key.upArrow ? "up" : "down", columns: props.columns });
      if (moved.cursorOffset !== state.current.cursorOffset) {
        event.stopImmediatePropagation(); update(moved); return;
      }
      event.stopImmediatePropagation();
      update(key.upArrow ? history.current.up(state.current) : history.current.down(state.current));
      return;
    }
    const action = promptActionFromKey(input, key, props.columns);
    if (!action) return;
    event.stopImmediatePropagation();
    const normalizedAction = action.type === "insert" && (event.keypress.isPasted || input.length > 1 || /[\r\n]/.test(input))
      ? { type: "paste-text" as const, text: input, columns: props.columns }
      : action;
    update(applyPromptEditorAction(state.current, normalizedAction), normalizedAction.type === "paste-text");
  }, { isActive: props.active });

  return null;
}
