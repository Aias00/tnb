import type { TnbLspDiagnostic, TnbLspFileDiagnostics } from "./types";

type TnbLspDiagnosticsListener = (entry: TnbLspFileDiagnostics) => void;

export class TnbLspDiagnosticsRegistry {
  #sequence = 0;
  #byFile = new Map<string, Map<string, TnbLspFileDiagnostics>>();
  #listeners = new Set<TnbLspDiagnosticsListener>();

  get sequence(): number {
    return this.#sequence;
  }

  update(input: {
    serverName: string;
    filePath: string;
    uri: string;
    version?: number;
    diagnostics: TnbLspDiagnostic[];
  }): TnbLspFileDiagnostics {
    const entry: TnbLspFileDiagnostics = {
      serverName: input.serverName,
      filePath: input.filePath,
      uri: input.uri,
      ...(input.version === undefined ? {} : { version: input.version }),
      diagnostics: input.diagnostics.slice().sort(compareDiagnostics),
      updatedAt: Date.now(),
      sequence: ++this.#sequence,
    };
    const fileEntries = this.#byFile.get(input.filePath) ?? new Map<string, TnbLspFileDiagnostics>();
    fileEntries.set(input.serverName, entry);
    this.#byFile.set(input.filePath, fileEntries);
    for (const listener of this.#listeners) listener(entry);
    return entry;
  }

  getByFile(filePath: string): TnbLspFileDiagnostics[] {
    const fileEntries = this.#byFile.get(filePath);
    return fileEntries ? [...fileEntries.values()].sort((left, right) => left.serverName.localeCompare(right.serverName)) : [];
  }

  clearFile(filePath: string): void {
    this.#byFile.delete(filePath);
  }

  reset(): void {
    this.#byFile.clear();
  }

  subscribe(listener: TnbLspDiagnosticsListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

function compareDiagnostics(left: TnbLspDiagnostic, right: TnbLspDiagnostic): number {
  return (
    left.severity - right.severity ||
    left.startLine - right.startLine ||
    left.startCharacter - right.startCharacter ||
    left.message.localeCompare(right.message)
  );
}
