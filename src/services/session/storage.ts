import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { ConversationMessage } from "../../core/message";
import type { WorktreeSessionState } from "../../core/workspace-state";
import type { TokenUsage } from "../../providers/types";
import { addUsage, EMPTY_USAGE, type UsageTotals } from "../usage/cost";
import { PERMISSION_MODES, type PermissionMode } from "../../core/permissions";

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
  messages: ConversationMessage[];
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
  readonly sessionId: string;
  readonly projectDir: string;
  readonly filePath: string;

  constructor(options: SessionStoreOptions) {
    this.sessionId = validateSessionId(options.sessionId);
    this.projectDir = options.projectDir ?? projectSessionDirectory(options.configDir, options.cwd);
    this.filePath = join(this.projectDir, `${this.sessionId}.jsonl`);
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

  async readState(): Promise<SessionState> {
    const text = await readFile(this.filePath, "utf8");
    const lines = text.split("\n");
    const hasUnterminatedTail = !text.endsWith("\n");
    const messages: ConversationMessage[] = [];
    let permissionMode: PermissionMode | undefined;
    let prePlanMode: PermissionMode | undefined;
    let worktree: WorktreeSessionState | undefined;
    let usage: UsageTotals | undefined;
    let title: string | undefined;
    let summary: string | undefined;
    let strategicIntent: string | undefined;
    let parentSessionId: string | undefined;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      if (hasUnterminatedTail && index === lines.length - 1) break;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid session record at line ${index + 1}`, { cause: error });
      }
      if (!isSessionRecord(value) || value.sessionId !== this.sessionId) {
        throw new Error(`Invalid session record at line ${index + 1}`);
      }
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
    return {
      messages,
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

  static async list(options: {
    configDir: string;
    cwd: string;
    limit?: number;
  }): Promise<SessionInfo[]> {
    const directory = projectSessionDirectory(options.configDir, options.cwd);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const candidates = await Promise.all(
      names
        .filter((name) => name.endsWith(".jsonl"))
        .map(async (name) => {
          const sessionId = basename(name, ".jsonl");
          const file = join(directory, name);
          const metadata = await stat(file);
          try {
            const state = await new SessionStore({
              configDir: options.configDir,
              cwd: options.cwd,
              sessionId,
            }).readState();
            const prompts = userPrompts(state.messages);
            const firstPrompt = prompts[0];
            const lastPrompt = prompts.at(-1);
            return {
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
              ...(prompts.length ? { userInputs: prompts } : {}),
            } satisfies SessionInfo;
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
    await mkdir(this.projectDir, { recursive: true });
    await appendFile(
      this.filePath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
  }

  private async readRecords(): Promise<SessionRecord[]> {
    const text = await readFile(this.filePath, "utf8");
    if (!text.endsWith("\n")) throw new Error("Cannot fork a session with an incomplete trailing record");
    return text.split("\n").filter(Boolean).map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid session record at line ${index + 1}`, { cause: error });
      }
      if (!isSessionRecord(value) || value.sessionId !== this.sessionId) {
        throw new Error(`Invalid session record at line ${index + 1}`);
      }
      return value;
    });
  }

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
  return (
    (message.role === "user" || message.role === "assistant") &&
    Array.isArray(message.content) &&
    message.content.every(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        typeof (block as { type?: unknown }).type === "string",
    )
  );
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
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    return text ? [text] : [];
  });
}

function userPrompts(messages: ConversationMessage[]): string[] {
  return sessionInputHistory(messages).map((input) => input.replace(/\s+/g, " "));
}
