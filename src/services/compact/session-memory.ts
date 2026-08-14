import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ConversationMessage } from "../../core/message";

const MINIMUM_TOKENS_TO_INITIALIZE = 60_000;
const MINIMUM_TOKENS_BETWEEN_UPDATES = 5_000;
const TOOL_CALLS_BETWEEN_UPDATES = 5;
const MAX_SNAPSHOT_CHARS = 48_000;

export type SessionMemorySnapshot = {
  version: 2;
  summary: string;
  tokenCount: number;
  toolCallCount: number;
  messageCount: number;
  updatedAt: string;
  compaction: {
    consecutiveFailures: number;
    lastAttemptAt?: string;
    lastSuccessAt?: string;
    lastStrategy?: string;
    suspendedUntil?: string;
  };
};

export class SessionMemoryStore {
  private snapshot: SessionMemorySnapshot | undefined;
  private refreshTask: Promise<void> | undefined;

  constructor(readonly filePath: string) {}

  async initialize(): Promise<void> {
    try {
      this.snapshot = parseSnapshot(JSON.parse(await readFile(this.filePath, "utf8")), this.filePath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.snapshot = undefined;
    }
  }

  current(): SessionMemorySnapshot | undefined {
    return this.snapshot ? structuredClone(this.snapshot) : undefined;
  }

  shouldRefresh(messages: ConversationMessage[], tokenCount: number): boolean {
    if (tokenCount < MINIMUM_TOKENS_TO_INITIALIZE) return false;
    const toolCallCount = countToolCalls(messages);
    if (!this.snapshot) return true;
    return tokenCount - this.snapshot.tokenCount >= MINIMUM_TOKENS_BETWEEN_UPDATES ||
      toolCallCount - this.snapshot.toolCallCount >= TOOL_CALLS_BETWEEN_UPDATES;
  }

  async save(summary: string, messages: ConversationMessage[], tokenCount: number): Promise<SessionMemorySnapshot> {
    const normalized = summary.trim().slice(0, MAX_SNAPSHOT_CHARS);
    if (!normalized) throw new Error("Session Memory summary must not be empty");
    const snapshot: SessionMemorySnapshot = {
      version: 2,
      summary: normalized,
      tokenCount,
      toolCallCount: countToolCalls(messages),
      messageCount: messages.length,
      updatedAt: new Date().toISOString(),
      compaction: this.snapshot?.compaction ?? { consecutiveFailures: 0 },
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
    this.snapshot = snapshot;
    return structuredClone(snapshot);
  }

  refreshInBackground(
    messages: ConversationMessage[],
    tokenCount: number,
    summarize: (messages: ConversationMessage[], signal?: AbortSignal) => Promise<string>,
  ): void {
    if (this.refreshTask || !this.shouldRefresh(messages, tokenCount)) return;
    const snapshotMessages = structuredClone(messages);
    this.refreshTask = summarize(snapshotMessages)
      .then((summary) => this.save(summary, snapshotMessages, tokenCount))
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => { this.refreshTask = undefined; });
  }

  canAttemptFullCompaction(now = Date.now()): boolean {
    const suspendedUntil = this.snapshot?.compaction.suspendedUntil;
    return !suspendedUntil || Date.parse(suspendedUntil) <= now;
  }

  async recordCompactionAttempt(strategy: string, succeeded: boolean): Promise<void> {
    const current = this.snapshot ?? {
      version: 2 as const,
      summary: "Session Memory has not been initialized.",
      tokenCount: 0,
      toolCallCount: 0,
      messageCount: 0,
      updatedAt: new Date().toISOString(),
      compaction: { consecutiveFailures: 0 },
    };
    const now = new Date();
    const consecutiveFailures = succeeded ? 0 : current.compaction.consecutiveFailures + 1;
    current.compaction = {
      consecutiveFailures,
      lastAttemptAt: now.toISOString(),
      ...(succeeded ? { lastSuccessAt: now.toISOString() } : {}),
      lastStrategy: strategy,
      ...(consecutiveFailures >= 3
        ? { suspendedUntil: new Date(now.getTime() + 5 * 60_000).toISOString() }
        : {}),
    };
    current.updatedAt = now.toISOString();
    await this.persist(current);
  }

  prompt(): string {
    if (!this.snapshot || this.snapshot.tokenCount === 0) return "";
    return [
      "# Session Memory",
      "",
      "This is a background snapshot of the current session. Prefer newer conversation messages when they conflict with it.",
      "",
      this.snapshot.summary,
    ].join("\n");
  }

  private async persist(snapshot: SessionMemorySnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
    this.snapshot = snapshot;
  }
}

function countToolCalls(messages: ConversationMessage[]): number {
  return messages.reduce((total, message) => total + (
    message.role === "assistant"
      ? message.content.filter((block) => block.type === "tool-use").length
      : 0
  ), 0);
}

function parseSnapshot(value: unknown, path: string): SessionMemorySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Session Memory: ${path}`);
  const snapshot = value as Omit<Partial<SessionMemorySnapshot>, "version"> & { version?: number };
  if (
    (snapshot.version !== 1 && snapshot.version !== 2) || typeof snapshot.summary !== "string" ||
    typeof snapshot.tokenCount !== "number" || typeof snapshot.toolCallCount !== "number" ||
    typeof snapshot.messageCount !== "number" || typeof snapshot.updatedAt !== "string"
  ) throw new Error(`Invalid Session Memory: ${path}`);
  const migrated = structuredClone(snapshot) as SessionMemorySnapshot;
  migrated.version = 2;
  migrated.compaction ??= { consecutiveFailures: 0 };
  return migrated;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
