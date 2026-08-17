export type PromptInputMode = "prompt" | "bash";
export type PastedImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type StoredPastedContent =
  | { id: number; type: "text"; content?: string; contentHash?: string }
  | { id: number; type: "image"; path: string; mediaType: PastedImageMediaType };

export type PersistedPromptInput = {
  version: 1;
  display: string;
  mode: PromptInputMode;
  pastedContents: StoredPastedContent[];
};

export type ResolvedPastedContent =
  | { id: number; type: "text"; content?: string; unresolved?: boolean }
  | { id: number; type: "image"; path: string; mediaType: PastedImageMediaType; missing?: boolean };

export type PromptHistoryEntry = {
  display: string;
  mode: PromptInputMode;
  pastedContents: Record<number, ResolvedPastedContent>;
};
