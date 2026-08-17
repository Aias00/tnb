import type { PromptEditorState, PromptHistoryEntry } from "./types";

export class PromptHistoryNavigator {
  private index = 0;
  private draft: PromptEditorState | undefined;
  constructor(private entries: PromptHistoryEntry[]) { this.index = entries.length; }

  replace(entries: PromptHistoryEntry[]): void { this.entries = entries; this.reset(); }
  reset(): void { this.index = this.entries.length; this.draft = undefined; }

  up(current: PromptEditorState): PromptEditorState {
    if (!this.entries.length || this.index === 0) return current;
    if (this.index === this.entries.length) this.draft = structuredClone(current);
    this.index -= 1;
    return fromEntry(this.entries[this.index]!);
  }

  down(current: PromptEditorState): PromptEditorState {
    if (this.index >= this.entries.length) return current;
    this.index += 1;
    return this.index === this.entries.length && this.draft ? structuredClone(this.draft) : fromEntry(this.entries[this.index]!);
  }
}

function fromEntry(entry: PromptHistoryEntry): PromptEditorState {
  const pastedContents: PromptEditorState["pastedContents"] = {};
  for (const [id, value] of Object.entries(entry.pastedContents)) {
    if (value.type === "text" && value.content !== undefined) pastedContents[Number(id)] = { id: value.id, type: "text", content: value.content };
    else if (value.type === "image") pastedContents[Number(id)] = value;
  }
  const ids = Object.keys(pastedContents).map(Number);
  return { value: entry.display, cursorOffset: 0, mode: entry.mode, vimMode: "INSERT", pastedContents, nextPasteId: ids.length ? Math.max(...ids) + 1 : 1 };
}
