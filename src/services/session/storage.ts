import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { ConversationMessage } from "../../core/message";
import type { WorktreeSessionState } from "../../core/workspace-state";
import type { TokenUsage } from "../../providers/types";
import { addUsage, EMPTY_USAGE, type UsageTotals } from "../usage/cost";
import { PERMISSION_MODES, type PermissionMode } from "../../core/permissions";
import { registerCleanup } from "../../utils/cleanup-registry";
import { parseJsonl } from "../../utils/jsonl";
import { appendJsonl } from "../../utils/jsonl-append";
import { lock, withFileLock } from "../../utils/lockfile";
import type { PersistedPromptInput, PromptHistoryEntry, StoredPastedContent } from "../../core/prompt-input";
import { PromptPasteStore } from "./prompt-paste-store";
import { CallJournal } from "./call-journal";

const sessionIndex = new Map<string, { signature: string; value: SessionInfo }>();

const sessionWriteQueues = new Map<string, Promise<void>>();
const pendingSessionWrites = new Set<Promise<void>>();

registerCleanup(() => flushSessionWrites());

type SessionRecordBase = {
  version: 1;
  sessionId: string;
  timestamp: string;
};

type MessageRecord = SessionRecordBase & {
  type: "message";
  message: ConversationMessage;
};

type CompactBoundaryRecord = SessionRecordBase & {
  strategy?: import("../compact/notice").CompactionInfo["strategy"];
  type: "compact_boundary";
  messages: ConversationMessage[];
  preTokens: number;
  postTokens: number;
  permissionMode?: PermissionMode;
  prePlanMode?: PermissionMode;
};

type RewindBoundaryRecord = SessionRecordBase & {
  type: "rewind_boundary";
  messages: ConversationMessage[];
};

type WorktreeStateRecord = SessionRecordBase & {
  type: "worktree_state";
  state: WorktreeSessionState | null;
};

type UsageRecord = SessionRecordBase & {
  type: "usage";
  provider: string;
  model: string;
  usage: TokenUsage;
  costUsd: number;
};

type SessionMetaRecord = SessionRecordBase & {
  type: "session_meta";
  title?: string;
  summary?: string;
  strategicIntent?: string;
  parentSessionId?: string;
};

type SessionRecord = MessageRecord | CompactBoundaryRecord | RewindBoundaryRecord | WorktreeStateRecord | UsageRecord | SessionMetaRecord;

export type SessionStoreOptions = {
  configDir: string;
  cwd: string;
  sessionId: string;
  projectDir?: string;
};

export type SessionState = {
  recordedInputs?: string[];
  historyTruncated?: boolean;
  messages: ConversationMessage[];
  promptHistory?: PromptHistoryEntry[];
  permissionMode?: PermissionMode;
  prePlanMode?: PermissionMode;
  worktree?: WorktreeSessionState;
  usage?: UsageTotals;
  title?: string;
  summary?: string;
  strategicIntent?: string;
  parentSessionId?: string;
};

export type SessionInfo = {
  historyTruncated?: boolean;
  sessionId: string;
  lastModified: number;
  fileSize: number;
  messageCount: number;
  firstPrompt?: string;
  lastPrompt?: string;
  userInputs?: string[];
  error?: string;
  title?: string;
  summary?: string;
  strategicIntent?: string;
  parentSessionId?: string;
};

export class SessionStore {
  revision = 0;
  readonly sessionId: string;
  readonly projectDir: string;
  readonly filePath: string;
  readonly calls: CallJournal;

  constructor(options: SessionStoreOptions) {
    this.sessionId = validateSessionId(options.sessionId);
    this.projectDir = options.projectDir ?? projectSessionDirectory(options.configDir, options.cwd);
    this.filePath = join(this.projectDir, `${this.sessionId}.jsonl`);
    this.calls = new CallJournal(join(this.projectDir, "calls", `${this.sessionId}.jsonl`));
  }

  /** Whole-run ownership is separate from short append locks. */
  async acquireRun(): Promise<() => Promise<void>> {
    await mkdir(this.projectDir, { recursive: true });
    const target = `${this.filePath}.owner`;
    const file = await open(target, "a", 0o600);
    await file.close();
    try { return await lock(target, { realpath: false, retries: 0 }); }
    catch (error) { throw new Error(`Session ${this.sessionId} already has an active runner`, { cause: error }); }
  }

  async append(messages: ConversationMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const timestamp = new Date().toISOString();
    await this.appendRecords(
      messages.map((message) => ({
        version: 1,
        type: "message",
        sessionId: this.sessionId,
        timestamp,
        message,
      } satisfies MessageRecord)),
    );
  }

  async appendCompactBoundary(input: {
    strategy?: import("../compact/notice").CompactionInfo["strategy"];
    messages: ConversationMessage[];
    preTokens: number;
    postTokens: number;
    permissionMode?: PermissionMode;
    prePlanMode?: PermissionMode;
  }): Promise<void> {
    await this.appendRecords([
      {
        version: 1,
        type: "compact_boundary",
        ...(input.strategy ? { strategy: input.strategy } : {}),
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        messages: structuredClone(input.messages),
        preTokens: input.preTokens,
        postTokens: input.postTokens,
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
        ...(input.prePlanMode ? { prePlanMode: input.prePlanMode } : {}),
      },
    ]);
  }

  async appendRewindBoundary(messages: ConversationMessage[]): Promise<void> {
    await this.appendRecords([{
      version: 1,
      type: "rewind_boundary",
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      messages: structuredClone(messages),
    }]);
  }

  async appendWorktreeState(state: WorktreeSessionState | null): Promise<void> {
    await this.appendRecords([{
      version: 1,
      type: "worktree_state",
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      state: state ? structuredClone(state) : null,
    }]);
  }

  async appendUsage(input: { provider: string; model: string; usage: TokenUsage; costUsd: number }): Promise<void> {
    await this.appendRecords([{
      version: 1,
      type: "usage",
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      ...structuredClone(input),
    }]);
  }

  async setTitle(title: string): Promise<void> {
    await this.updateTopic({ title });
  }

  async updateTopic(input: { title?: string; summary?: string; strategicIntent?: string }): Promise<void> {
    const title = normalizeTopicField(input.title, "title");
    const summary = normalizeTopicField(input.summary, "summary");
    const strategicIntent = normalizeTopicField(input.strategicIntent, "strategic intent");
    if (!title && !summary && !strategicIntent) {
      throw new Error("Session topic update requires a title, summary, or strategic intent");
    }
    await this.appendRecords([{
      version: 1,
      type: "session_meta",
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(strategicIntent ? { strategicIntent } : {}),
    }]);
  }

  async forkTo(sessionId: string): Promise<SessionStore> {
    const target = new SessionStore({
      configDir: "",
      cwd: "",
      sessionId,
      projectDir: this.projectDir,
    });
    const records = await this.readRecords();
    const inherited = records.filter((record) =>
      record.type === "message" || record.type === "compact_boundary" || record.type === "session_meta"
    );
    const now = new Date().toISOString();
    const output: SessionRecord[] = [
      ...inherited.map((record) => ({ ...structuredClone(record), sessionId: target.sessionId })),
      {
        version: 1,
        type: "session_meta",
        sessionId: target.sessionId,
        timestamp: now,
        parentSessionId: this.sessionId,
      },
    ];
    await mkdir(this.projectDir, { recursive: true });
    await writeFile(target.filePath, `${output.map((record) => JSON.stringify(record)).join("\n")}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return target;
  }

  async read(): Promise<ConversationMessage[]> {
    return (await this.readState()).messages;
  }

  async readState(options: { resolvePromptHistory?: boolean } = {}): Promise<SessionState> {
    await flushSessionWrites(this.filePath);
    const text = await readFile(this.filePath, "utf8");
    const messages: ConversationMessage[] = [];
    let permissionMode: PermissionMode | undefined;
    let prePlanMode: PermissionMode | undefined;
    let worktree: WorktreeSessionState | undefined;
    let usage: UsageTotals | undefined;
    let title: string | undefined;
    let summary: string | undefined;
    let strategicIntent: string | undefined;
    let parentSessionId: string | undefined;

    const records = parseJsonl<unknown>(text);
    this.revision = records.length;
    for (const value of records) {
      if (!isSessionRecord(value) || value.sessionId !== this.sessionId) continue;
      if (value.type === "compact_boundary") {
        messages.splice(0, messages.length, ...structuredClone(value.messages));
        permissionMode = value.permissionMode;
        prePlanMode = value.prePlanMode;
      } else if (value.type === "rewind_boundary") {
        messages.splice(0, messages.length, ...structuredClone(value.messages));
      } else if (value.type === "worktree_state") {
        worktree = value.state ? structuredClone(value.state) : undefined;
      } else if (value.type === "usage") {
        const tokens = addUsage(usage ?? EMPTY_USAGE, value.usage);
        usage = { ...tokens, costUsd: (usage?.costUsd ?? 0) + value.costUsd };
      } else if (value.type === "session_meta") {
        if (value.title !== undefined) title = value.title;
        if (value.summary !== undefined) summary = value.summary;
        if (value.strategicIntent !== undefined) strategicIntent = value.strategicIntent;
        if (value.parentSessionId !== undefined) parentSessionId = value.parentSessionId;
      } else {
        messages.push(value.message);
      }
    }
    const recordedInputs: string[] = []; let historyBytes = 0, historyTruncated = false;
    if (options.resolvePromptHistory === false) for (const value of [...records].reverse()) {
      if (!isSessionRecord(value) || value.type !== "message" || value.message.role !== "user" || value.message.content.some(block => block.type === "tool-result")) continue;
      const input = value.message.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim();
      if (!input) continue;
      if (Buffer.byteLength(input) > 32768 || historyBytes + Buffer.byteLength(input) > 256 * 1024 || recordedInputs.length >= 1000) { historyTruncated = true; continue; }
      recordedInputs.unshift(input); historyBytes += Buffer.byteLength(input);
    }
    return {
      messages,
      ...(options.resolvePromptHistory === false ? { recordedInputs, historyTruncated } : {}),
      ...(options.resolvePromptHistory === false ? {} : { promptHistory: await sessionPromptHistory(messages, new PromptPasteStore(this.projectDir)) }),
      ...(permissionMode ? { permissionMode } : {}),
      ...(prePlanMode ? { prePlanMode } : {}),
      ...(worktree ? { worktree } : {}),
      ...(usage ? { usage } : {}),
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(strategicIntent ? { strategicIntent } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
    };
  }

  async delete(): Promise<void> {
    await unlink(this.filePath);
  }

  static async latestSessionId(options: {
    configDir: string;
    cwd: string;
  }): Promise<string | undefined> {
    const directory = projectSessionDirectory(options.configDir, options.cwd);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const candidates = await Promise.all(
      names
        .filter((name) => name.endsWith(".jsonl"))
        .map(async (name) => ({ name, mtimeMs: (await stat(join(directory, name))).mtimeMs })),
    );
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const latest = candidates[0]?.name;
    return latest ? basename(latest, ".jsonl") : undefined;
  }

  async audit(): Promise<{ messages: ConversationMessage[]; compactions: Array<{ strategy?: string; timestamp: string; preTokens: number; postTokens: number; summary: string }> }> {
    await flushSessionWrites(this.filePath);
    const info = await stat(this.filePath).catch(error => { if (isMissing(error)) return undefined; throw error; });
    if (!info) return { messages: [], compactions: [] };
    if (info.size > 32 * 1024 * 1024) throw new Error("Session audit exceeds 32 MiB; export the session for offline review");
    const records = parseJsonl<unknown>(await readFile(this.filePath, "utf8")).filter(isSessionRecord).filter(record => record.sessionId === this.sessionId);
    return { messages: records.flatMap(record => record.type === "message" ? [record.message] : []),
      compactions: records.flatMap(record => record.type === "compact_boundary" ? [{ strategy: record.strategy, timestamp: record.timestamp, preTokens: record.preTokens, postTokens: record.postTokens, summary: record.strategy === "microcompact" || record.strategy === "context-collapse" ? "" : record.messages.flatMap(message => message.content.filter(block => block.type === "text").map(block => block.text)).slice(0, 1).join("") }] : []) };
  }

  static async list(options: {
    configDir: string;
    cwd: string;
    limit?: number;
    metadataOnly?: boolean;
  }): Promise<SessionInfo[]> {
    const directory = projectSessionDirectory(options.configDir, options.cwd);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const files = await Promise.all(names.filter(name => name.endsWith(".jsonl")).map(async name => ({ name, metadata: await stat(join(directory, name)) })));
    files.sort((a, b) => b.metadata.mtimeMs - a.metadata.mtimeMs);
    const selected = options.limit === undefined ? files : files.slice(0, options.limit);
    const candidates = await Promise.all(selected.map(async ({ name, metadata }) => {
          const sessionId = basename(name, ".jsonl");
          const file = join(directory, name);
          if (options.metadataOnly) return { sessionId, lastModified: metadata.mtimeMs, fileSize: metadata.size, messageCount: 0 } satisfies SessionInfo;
          const signature = `${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}:${metadata.ino}`;
          const cached = sessionIndex.get(file);
          if (cached?.signature === signature) return structuredClone(cached.value);
          try {
            const state = await new SessionStore({
              configDir: options.configDir,
              cwd: options.cwd,
              sessionId,
            }).readState({ resolvePromptHistory: false });
            const prompts = userPrompts(state.messages);
            const firstPrompt = prompts[0];
            const lastPrompt = prompts.at(-1);
            const value = {
              sessionId,
              lastModified: metadata.mtimeMs,
              fileSize: metadata.size,
              messageCount: state.messages.length,
              ...(state.title ? { title: state.title } : {}),
              ...(state.summary ? { summary: state.summary } : {}),
              ...(state.strategicIntent ? { strategicIntent: state.strategicIntent } : {}),
              ...(state.parentSessionId ? { parentSessionId: state.parentSessionId } : {}),
              ...(firstPrompt ? { firstPrompt } : {}),
              ...(lastPrompt ? { lastPrompt } : {}),
              ...(state.recordedInputs !== undefined ? { userInputs: state.recordedInputs } : prompts.length ? { userInputs: prompts } : {}),
              ...(state.historyTruncated ? { historyTruncated: true } : {}),
            } satisfies SessionInfo;
            sessionIndex.delete(file); sessionIndex.set(file, { signature, value });
            if (sessionIndex.size > 128) sessionIndex.delete(sessionIndex.keys().next().value!);
            return structuredClone(value);
          } catch (error) {
            return {
              sessionId,
              lastModified: metadata.mtimeMs,
              fileSize: metadata.size,
              messageCount: 0,
              error: error instanceof Error ? error.message : String(error),
            } satisfies SessionInfo;
          }
        }),
    );
    candidates.sort((left, right) => right.lastModified - left.lastModified);
    return options.limit === undefined ? candidates : candidates.slice(0, options.limit);
  }

  private async appendRecords(records: SessionRecord[]): Promise<void> {
    await queueSessionWrite(this.filePath, async () => {
      await appendJsonl(this.filePath, records);
      this.revision += records.length;
    });
  }

  private async readRecords(): Promise<SessionRecord[]> {
    await flushSessionWrites(this.filePath);
    const text = await readFile(this.filePath, "utf8");
    return parseJsonl<unknown>(text).filter(
      (value): value is SessionRecord => isSessionRecord(value) && value.sessionId === this.sessionId,
    );
  }

}

function queueSessionWrite(filePath: string, operation: () => Promise<void>): Promise<void> {
  const previous = sessionWriteQueues.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  sessionWriteQueues.set(filePath, current);
  pendingSessionWrites.add(current);
  void current.finally(() => {
    pendingSessionWrites.delete(current);
    if (sessionWriteQueues.get(filePath) === current) sessionWriteQueues.delete(filePath);
  }).catch(() => undefined);
  return current;
}

export async function flushSessionWrites(filePath?: string): Promise<void> {
  if (filePath) {
    await sessionWriteQueues.get(filePath);
    return;
  }
  await Promise.allSettled(Array.from(pendingSessionWrites));
}

export function projectSessionDirectory(configDir: string, cwd: string): string {
  const canonical = canonicalPath(cwd);
  const projectId = createHash("sha256").update(canonical).digest("hex").slice(0, 20);
  return join(resolve(configDir), "projects", projectId);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(resolve(path)).normalize("NFC");
  } catch {
    return resolve(path).normalize("NFC");
  }
}

function validateSessionId(sessionId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
  return sessionId;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<SessionRecord> & Record<string, unknown>;
  const baseIsValid =
    record.version === 1 &&
    typeof record.sessionId === "string" &&
    typeof record.timestamp === "string";
  if (!baseIsValid) return false;
  if (record.type === "message") return isConversationMessage(record.message);
  if (record.type === "rewind_boundary") {
    return Array.isArray(record.messages) && record.messages.every(isConversationMessage);
  }
  if (record.type === "worktree_state") return record.state === null || isWorktreeState(record.state);
  if (record.type === "usage") {
    return typeof record.provider === "string" && typeof record.model === "string" &&
      typeof record.costUsd === "number" && isTokenUsage(record.usage);
  }
  if (record.type === "session_meta") {
    return (record.title === undefined || typeof record.title === "string" && record.title.trim().length > 0) &&
      (record.summary === undefined || typeof record.summary === "string" && record.summary.trim().length > 0) &&
      (record.strategicIntent === undefined || typeof record.strategicIntent === "string" && record.strategicIntent.trim().length > 0) &&
      (record.parentSessionId === undefined || typeof record.parentSessionId === "string");
  }
  return (
    record.type === "compact_boundary" &&
    Array.isArray(record.messages) &&
    record.messages.every(isConversationMessage) &&
    typeof record.preTokens === "number" &&
    typeof record.postTokens === "number" &&
    isOptionalPermissionMode(record.permissionMode) &&
    isOptionalPermissionMode(record.prePlanMode)
  );
}

function normalizeTopicField(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error(`Session ${name} must be a non-empty string`);
  return normalized;
}

function isTokenUsage(value: unknown): value is TokenUsage {
  if (typeof value !== "object" || value === null) return false;
  const usage = value as Partial<TokenUsage>;
  return [usage.inputTokens, usage.outputTokens, usage.cacheReadInputTokens, usage.cacheCreationInputTokens]
    .every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0);
}

function isWorktreeState(value: unknown): value is WorktreeSessionState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<WorktreeSessionState>;
  return [state.originalCwd, state.worktreePath, state.worktreeName, state.worktreeBranch, state.originalHead]
    .every((entry) => typeof entry === "string" && entry.length > 0);
}

function isOptionalPermissionMode(value: unknown): value is PermissionMode | undefined {
  return value === undefined || PERMISSION_MODES.includes(value as PermissionMode);
}

function isConversationMessage(value: unknown): value is ConversationMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { role?: unknown; content?: unknown };
  const valid = (
    (message.role === "user" || message.role === "assistant") &&
    Array.isArray(message.content) &&
    message.content.every(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        typeof (block as { type?: unknown }).type === "string",
    )
  );
  if (!valid) return false;
  return message.role !== "user" || !("promptInput" in message) || isPersistedPromptInput((message as { promptInput?: unknown }).promptInput);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function sessionInputHistory(messages: ConversationMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.role !== "user") return [];
    if (message.content.some((block) => block.type === "tool-result")) return [];
    if (message.promptInput?.display.trim()) return [message.promptInput.display.trim()];
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    return text ? [text] : [];
  });
}

export async function sessionPromptHistory(
  messages: ConversationMessage[],
  pasteStore: PromptPasteStore,
): Promise<PromptHistoryEntry[]> {
  const entries: PromptHistoryEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user" || message.content.some((block) => block.type === "tool-result")) continue;
    if (!message.promptInput) {
      const display = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
      if (display) entries.push({ display, mode: "prompt", pastedContents: {} });
      continue;
    }
    const pastedContents: PromptHistoryEntry["pastedContents"] = {};
    for (const stored of message.promptInput.pastedContents) {
      if (stored.type === "text") {
        const content = await pasteStore.resolveText(stored);
        pastedContents[stored.id] = content === undefined
          ? { id: stored.id, type: "text", unresolved: true }
          : { id: stored.id, type: "text", content };
      } else {
        const missing = await stat(stored.path).then((value) => !value.isFile()).catch(() => true);
        pastedContents[stored.id] = { ...stored, ...(missing ? { missing: true } : {}) };
      }
    }
    entries.push({ display: message.promptInput.display, mode: message.promptInput.mode, pastedContents });
  }
  return entries;
}

function isPersistedPromptInput(value: unknown): value is PersistedPromptInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prompt = value as Partial<PersistedPromptInput>;
  if (prompt.version !== 1 || typeof prompt.display !== "string" || !prompt.display.trim() ||
      (prompt.mode !== "prompt" && prompt.mode !== "bash") || !Array.isArray(prompt.pastedContents)) return false;
  const ids = new Set<number>();
  for (const content of prompt.pastedContents) {
    if (!isStoredPastedContent(content) || ids.has(content.id)) return false;
    ids.add(content.id);
  }
  return true;
}

function isStoredPastedContent(value: unknown): value is StoredPastedContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const content = value as Partial<StoredPastedContent>;
  if (!Number.isSafeInteger(content.id) || Number(content.id) <= 0) return false;
  if (content.type === "text") {
    const inline = typeof content.content === "string";
    const hash = typeof content.contentHash === "string" && /^[a-f0-9]{64}$/.test(content.contentHash);
    return inline !== hash;
  }
  return content.type === "image" && typeof content.path === "string" && content.path.length > 0 &&
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(content.mediaType));
}

function userPrompts(messages: ConversationMessage[]): string[] {
  return sessionInputHistory(messages).map((input) => input.replace(/\s+/g, " "));
}
