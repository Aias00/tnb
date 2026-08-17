import type { PromptEditorState } from "./types";

export class PromptUndoBuffer {
  private entries: PromptEditorState[] = [];
  private index = -1;
  private lastPushAt = 0;

  constructor(private readonly limit = 100, private readonly debounceMs = 250) {}

  push(state: PromptEditorState, structural = false, now = Date.now()): void {
    const snapshot = structuredClone(state);
    if (this.entries.length && statesEqual(this.entries[this.entries.length - 1]!, snapshot)) return;
    if (!structural && this.entries.length > 1 && now - this.lastPushAt < this.debounceMs) {
      this.entries[this.entries.length - 1] = snapshot;
      this.index = this.entries.length - 1;
    } else {
      this.entries = this.entries.slice(0, this.index + 1);
      this.entries.push(snapshot);
      if (this.entries.length > this.limit) this.entries.shift();
      this.index = this.entries.length - 1;
    }
    this.lastPushAt = now;
  }

  undo(): PromptEditorState | undefined {
    if (this.index <= 0) return undefined;
    this.index -= 1;
    return structuredClone(this.entries[this.index]);
  }

  redo(): PromptEditorState | undefined {
    if (this.index < 0 || this.index >= this.entries.length - 1) return undefined;
    this.index += 1;
    return structuredClone(this.entries[this.index]);
  }
}

function statesEqual(left: PromptEditorState, right: PromptEditorState): boolean {
  return left.value === right.value && left.cursorOffset === right.cursorOffset && left.mode === right.mode &&
    left.vimMode === right.vimMode && left.nextPasteId === right.nextPasteId &&
    JSON.stringify(left.pastedContents) === JSON.stringify(right.pastedContents);
}

export class PromptStash {
  private state: PromptEditorState | undefined;
  stash(current: PromptEditorState): PromptEditorState | undefined {
    if (!current.value.trim()) {
      const restored = this.state;
      this.state = undefined;
      return restored ? structuredClone(restored) : undefined;
    }
    this.state = structuredClone(current);
    return undefined;
  }
  hasValue(): boolean { return this.state !== undefined; }
}
