import { Cursor } from "../input/cursor";
import { pruneOrphanedPastedContents } from "./editor-state";
import { transition, type TransitionContext } from "./vim/transitions";
import { createInitialPersistentState, type CommandState, type PersistentState, type RecordedChange } from "./vim/types";
import {
  executeIndent, executeJoin, executeOpenLine, executeOperatorFind,
  executeOperatorMotion, executeOperatorTextObj, executeReplace, executeToggleCase, executeX,
} from "./vim/operators";
import type { PromptEditorState } from "./types";

export class VimInputController {
  private command: CommandState = { type: "idle" };
  private persistent: PersistentState = createInitialPersistentState();

  reset(): void { this.command = { type: "idle" }; }

  handleNormal(editor: PromptEditorState, input: string, columns: number, onUndo?: () => PromptEditorState | undefined): PromptEditorState {
    let next = structuredClone(editor);
    const cursor = Cursor.fromText(next.value, columns, next.cursorOffset);
    const context = (): TransitionContext => ({
      cursor: Cursor.fromText(next.value, columns, next.cursorOffset),
      text: next.value,
      setText: (text) => { next.value = text; },
      setOffset: (offset) => { next.cursorOffset = offset; },
      enterInsert: (offset) => { next.cursorOffset = offset; next.vimMode = "INSERT"; },
      getRegister: () => this.persistent.register,
      setRegister: (content, linewise) => { this.persistent.register = content; this.persistent.registerIsLinewise = linewise; },
      getLastFind: () => this.persistent.lastFind,
      setLastFind: (type, char) => { this.persistent.lastFind = { type, char }; },
      recordChange: (change) => { this.persistent.lastChange = change; },
      onUndo: () => { const restored = onUndo?.(); if (restored) next = restored; },
      onDotRepeat: () => { next = this.replay(next, columns); },
    });
    if (input === "escape") { this.reset(); return next; }
    const result = transition(this.command, input, context());
    if (result.execute) { result.execute(); this.command = { type: "idle" }; }
    else this.command = result.next ?? { type: "idle" };
    void cursor;
    return pruneOrphanedPastedContents(next);
  }

  private replay(editor: PromptEditorState, columns: number): PromptEditorState {
    const change = this.persistent.lastChange;
    if (!change) return editor;
    let next = structuredClone(editor);
    const ctx: TransitionContext = {
      cursor: Cursor.fromText(next.value, columns, next.cursorOffset), text: next.value,
      setText: (text) => { next.value = text; }, setOffset: (offset) => { next.cursorOffset = offset; },
      enterInsert: (offset) => { next.cursorOffset = offset; next.vimMode = "INSERT"; },
      getRegister: () => this.persistent.register,
      setRegister: (content, linewise) => { this.persistent.register = content; this.persistent.registerIsLinewise = linewise; },
      getLastFind: () => this.persistent.lastFind,
      setLastFind: (type, char) => { this.persistent.lastFind = { type, char }; },
      recordChange: () => {}, onDotRepeat: () => {},
    };
    replayChange(change, ctx);
    return pruneOrphanedPastedContents(next);
  }
}

function replayChange(change: RecordedChange, ctx: TransitionContext): void {
  switch (change.type) {
    case "insert": { const cursor = ctx.cursor.insert(change.text); ctx.setText(cursor.text); ctx.setOffset(cursor.offset); break; }
    case "x": executeX(change.count, ctx); break;
    case "replace": executeReplace(change.char, change.count, ctx); break;
    case "toggleCase": executeToggleCase(change.count, ctx); break;
    case "indent": executeIndent(change.dir, change.count, ctx); break;
    case "join": executeJoin(change.count, ctx); break;
    case "openLine": executeOpenLine(change.direction, ctx); break;
    case "operator": executeOperatorMotion(change.op, change.motion, change.count, ctx); break;
    case "operatorFind": executeOperatorFind(change.op, change.find, change.char, change.count, ctx); break;
    case "operatorTextObj": executeOperatorTextObj(change.op, change.scope, change.objType, change.count, ctx); break;
  }
}
