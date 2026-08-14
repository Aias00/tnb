import type { TranscriptEntry } from "./model";

export type TranscriptSearchState = {
  query: string;
  matches: string[];
  index: number;
};

export function searchTranscript(entries: readonly TranscriptEntry[], query: string): string[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return entries
    .filter((entry) => transcriptEntryText(entry).toLocaleLowerCase().includes(needle))
    .map((entry) => entry.id);
}

export function moveTranscriptMatch(state: TranscriptSearchState, direction: -1 | 1): TranscriptSearchState {
  if (!state.matches.length) return { ...state, index: 0 };
  return { ...state, index: (state.index + direction + state.matches.length) % state.matches.length };
}

export function transcriptEntryText(entry: TranscriptEntry): string {
  if (entry.kind === "user") return entry.text;
  if (entry.kind === "assistant") return entry.text;
  if (entry.kind === "system") return entry.text;
  return [entry.name, stableText(entry.input), entry.output ?? ""].filter(Boolean).join("\n");
}

function stableText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
