import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ConversationMessage } from "../../core/message";

export class SubagentTranscript {
  readonly filePath: string;

  constructor(options: { projectDir: string; sessionId: string; agentId: string }) {
    this.filePath = join(
      options.projectDir,
      options.sessionId,
      "subagents",
      `${options.agentId}.jsonl`,
    );
  }

  async append(message: ConversationMessage): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(
      this.filePath,
      `${JSON.stringify({
        version: 1,
        timestamp: new Date().toISOString(),
        message,
      })}\n`,
      "utf8",
    );
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
    return coalesceUserMessages(repairInterruptedTail(messages));
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

function repairInterruptedTail(messages: ConversationMessage[]): ConversationMessage[] {
  const restored = structuredClone(messages);
  const last = restored.at(-1);
  if (last?.role !== "assistant") return restored;
  if (!last.content.some((block) => block.type === "tool-use")) return restored;
  last.content = last.content.filter((block) => block.type !== "tool-use");
  if (!last.content.length) restored.pop();
  return restored;
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
