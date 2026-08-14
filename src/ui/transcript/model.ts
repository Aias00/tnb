export type TranscriptBase = {
  id: string;
  sequence: number;
  revision: number;
};

export type TranscriptToolProgress = {
  output?: string;
  fullOutput?: string;
  elapsedTimeSeconds?: number;
  totalLines?: number;
  totalBytes?: number;
  timeoutMs?: number;
  taskId?: string;
  progress?: number;
  progressTotal?: number;
  message?: string;
};

export type TranscriptEntry =
  | (TranscriptBase & { kind: "user"; text: string })
  | (TranscriptBase & { kind: "assistant"; text: string; streaming: boolean })
  | (TranscriptBase & { kind: "system"; text: string; tone: "info" | "error" })
  | (TranscriptBase & {
      kind: "tool";
      toolUseId: string;
      name: string;
      input: unknown;
      status: "running" | "completed" | "failed";
      output?: string;
      startedAt?: number;
      durationMs?: number;
      progress?: TranscriptToolProgress;
    });

export type TranscriptEntryInput =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | { kind: "system"; text: string; tone: "info" | "error" }
  | {
      kind: "tool";
      toolUseId: string;
      name: string;
      input: unknown;
      status: "running" | "completed" | "failed";
      output?: string;
      startedAt?: number;
      durationMs?: number;
      progress?: TranscriptToolProgress;
    };

export function createTranscriptEntry(
  sequence: number,
  input: TranscriptEntryInput,
  id = `transcript-${sequence}`,
): TranscriptEntry {
  if (input.kind === "assistant") {
    return { ...input, streaming: input.streaming ?? false, id, sequence, revision: 0 };
  }
  return { ...input, id, sequence, revision: 0 } as TranscriptEntry;
}

export function reviseTranscriptEntry<T extends TranscriptEntry>(
  entry: T,
  changes: Partial<Omit<T, keyof TranscriptBase | "kind">>,
): T {
  return { ...entry, ...changes, revision: entry.revision + 1 };
}
