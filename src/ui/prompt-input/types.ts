import type { PersistedPromptInput, PromptHistoryEntry as CorePromptHistoryEntry, PromptInputMode, PastedImageMediaType } from "../../core/prompt-input";

export type PastedContent =
  | { id: number; type: "text"; content: string }
  | { id: number; type: "image"; path: string; mediaType: PastedImageMediaType; missing?: boolean };

export type PromptEditorState = {
  value: string;
  cursorOffset: number;
  mode: PromptInputMode;
  vimMode: "INSERT" | "NORMAL";
  pastedContents: Record<number, PastedContent>;
  nextPasteId: number;
};

export type PromptHistoryEntry = CorePromptHistoryEntry;

export type PromptInputSubmit = {
  display: string;
  expanded: string;
  mode: PromptInputMode;
  pastedContents: Record<number, PastedContent>;
};

export type PromptInputHandle = {
  focus(): void;
  clear(): void;
  setState(state: PromptEditorState): void;
  getState(): PromptEditorState;
  stash(): boolean;
  popStash(): boolean;
};
