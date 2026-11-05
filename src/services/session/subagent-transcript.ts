import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ConversationMessage } from "../../core/message";
import { CallJournal } from "./call-journal";
import { appendJsonl } from "../../utils/jsonl-append";

export class SubagentTranscript {
  readonly filePath: string;
  readonly calls: CallJournal;

  constructor(options: { projectDir: string; sessionId: string; agentId: string }) {
    this.filePath = join(
      options.projectDir,
      options.sessionId,
      "subagents",
      `${options.agentId}.jsonl`,
    );
    this.calls = new CallJournal(`${this.filePath}.calls`);
  }

  async append(message: ConversationMessage): Promise<void> {
    await appendJsonl(this.filePath, [{ version: 1, timestamp: new Date().toISOString(), message }]);
  }

  async read(): Promise<ConversationMessage[]> {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const messages: ConversationMessage[] = [];
    const lines = source.split("\n");
    const hasUnterminatedTail = lines.at(-1) !== "";
    if (!hasUnterminatedTail) lines.pop();
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      try {
        messages.push(parseRecord(JSON.parse(line), this.filePath));
      } catch (error) {
        if (hasUnterminatedTail && index === lines.length - 1) break;
        throw error;
      }
    }
    // Preserve outstanding calls: a missing result does not prove the effect never happened.
    // The shared recovery gate reconciles journaled outcomes or blocks unknown effects.
    return this.calls.recover(coalesceUserMessages(messages), (message) => this.append(message));
  }
}

function parseRecord(value: unknown, path: string): ConversationMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid subagent transcript record: ${path}`);
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.timestamp !== "string" || !isConversationMessage(record.message)) {
    throw new Error(`Invalid subagent transcript record: ${path}`);
  }
  return structuredClone(record.message);
}

function isConversationMessage(value: unknown): value is ConversationMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if ((message.role !== "user" && message.role !== "assistant") || !Array.isArray(message.content)) return false;
  return message.content.every((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return false;
    const item = block as Record<string, unknown>;
    if (message.role === "assistant") {
      return (item.type === "text" && typeof item.text === "string") ||
        (item.type === "thinking" && typeof item.thinking === "string") ||
        (item.type === "tool-use" && typeof item.id === "string" && typeof item.name === "string");
    }
    return (item.type === "text" && typeof item.text === "string") ||
      (item.type === "tool-result" && typeof item.toolUseId === "string" && typeof item.content === "string" && typeof item.isError === "boolean") ||
      (item.type === "image" && typeof item.source === "object") ||
      (item.type === "document" && typeof item.source === "object" && typeof item.filename === "string");
  });
}

function coalesceUserMessages(messages: ConversationMessage[]): ConversationMessage[] {
  const normalized: ConversationMessage[] = [];
  for (const message of messages) {
    const previous = normalized.at(-1);
    if (previous?.role === "user" && message.role === "user") {
      previous.content.push(...structuredClone(message.content));
    } else {
      normalized.push(structuredClone(message));
    }
  }
  return normalized;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
