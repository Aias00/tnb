import type { MediaBlock, ToolResultBlock, ToolUseBlock } from "./message";
import type { ConversationMessage } from "./message";
import { createHash } from "node:crypto";

export function toolCallScope(messages: readonly ConversationMessage[]): string {
  const normalized: ConversationMessage[] = [];
  for (const message of messages) {
    const previous = normalized.at(-1);
    if (message.role === "user" && previous?.role === "user") {
      previous.content.push(...structuredClone(message.content));
    } else normalized.push({ role: message.role, content: structuredClone(message.content) } as ConversationMessage);
  }
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export type JournalOutcome = { result: ToolResultBlock; attachments: MediaBlock[] };

/** Storage-owned lifecycle barriers. A failed barrier must stop the loop, not retry a side effect. */
export interface ToolCallJournal {
  scope?(messages: readonly ConversationMessage[]): string;
  intend(call: ToolUseBlock, input: unknown, scope?: string): Promise<string>;
  dispatch(invocationId: string): Promise<void>;
  settle(invocationId: string, outcome: JournalOutcome): Promise<void>;
}
