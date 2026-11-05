import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ConversationMessage } from "../../core/message";
import { withFileLock } from "../../utils/lockfile";

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
  /** Monotonic session-log revision, independent of context size after compaction. */
  sourceRevision?: number;
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

  async save(summary: string, messages: ConversationMessage[], tokenCount: number, sourceRevision?: number, signal?: AbortSignal): Promise<SessionMemorySnapshot> {
    signal?.throwIfAborted();
    const normalized = summary.trim().slice(0, MAX_SNAPSHOT_CHARS);
    if (!normalized) throw new Error("Session Memory summary must not be empty");
    const snapshot: SessionMemorySnapshot = {
      version: 2,
      summary: normalized,
      tokenCount,
      toolCallCount: countToolCalls(messages),
      messageCount: messages.length,
      updatedAt: new Date().toISOString(),
      ...(sourceRevision === undefined ? {} : { sourceRevision }),
      compaction: this.snapshot?.compaction ?? { consecutiveFailures: 0 },
    };
    await this.update((current) => {
      if (current && compareSnapshotProgress(current, snapshot) > 0) return current;
      return { ...snapshot, compaction: current?.compaction ?? snapshot.compaction };
    }, signal);
    return this.current()!;
  }

  refreshInBackground(
    messages: ConversationMessage[],
    tokenCount: number,
    summarize: (messages: ConversationMessage[], signal?: AbortSignal) => Promise<string>,
    sourceRevision?: number,
    signal?: AbortSignal,
  ): void {
    if (this.refreshTask || !this.shouldRefresh(messages, tokenCount)) return;
    const snapshotMessages = structuredClone(messages);
    this.refreshTask = summarize(snapshotMessages, signal)
      .then((summary) => { signal?.throwIfAborted(); return this.save(summary, snapshotMessages, tokenCount, sourceRevision, signal); })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => { this.refreshTask = undefined; });
  }

  canAttemptFullCompaction(now = Date.now()): boolean {
    const suspendedUntil = this.snapshot?.compaction.suspendedUntil;
    return !suspendedUntil || Date.parse(suspendedUntil) <= now;
  }

  async recordCompactionAttempt(strategy: string, succeeded: boolean): Promise<void> {
    await this.update((snapshot) => {
      const now = new Date();
      const current = snapshot ?? emptySnapshot(now);
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
      return current;
    });
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

  private async update(operation: (current: SessionMemorySnapshot | undefined) => SessionMemorySnapshot, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await withFileLock(this.filePath, async () => {
      signal?.throwIfAborted();
      const current = await readSnapshot(this.filePath);
      signal?.throwIfAborted();
      const snapshot = operation(current);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx", signal });
        signal?.throwIfAborted();
        await rename(temporary, this.filePath);
      } finally {
        await unlink(temporary).catch((error) => { if (!isMissing(error)) throw error; });
      }
      this.snapshot = snapshot;
    });
  }
}

function emptySnapshot(now: Date): SessionMemorySnapshot {
  return {
    version: 2,
    summary: "Session Memory has not been initialized.",
    tokenCount: 0,
    toolCallCount: 0,
    messageCount: 0,
    updatedAt: now.toISOString(),
    compaction: { consecutiveFailures: 0 },
  };
}

async function readSnapshot(path: string): Promise<SessionMemorySnapshot | undefined> {
  try {
    return parseSnapshot(JSON.parse(await readFile(path, "utf8")), path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function compareSnapshotProgress(left: SessionMemorySnapshot, right: SessionMemorySnapshot): number {
  if (left.sourceRevision !== undefined || right.sourceRevision !== undefined) {
    return (left.sourceRevision ?? -1) - (right.sourceRevision ?? -1);
  }
  return left.tokenCount - right.tokenCount || left.toolCallCount - right.toolCallCount || left.messageCount - right.messageCount;
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
