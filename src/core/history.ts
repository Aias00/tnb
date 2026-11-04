import type { ConversationMessage, ToolUseBlock } from "./message";

/** A provider request must never contain an orphan result or an unfinished tool round. */
export function assertBalancedToolHistory(messages: readonly ConversationMessage[]): void {
  const pending = new Map<string, ToolUseBlock>();
  for (const message of messages) {
    if (message.role === "assistant") {
      if (pending.size) throw new Error(`Unresolved tool calls: ${[...pending.keys()].join(", ")}`);
      for (const block of message.content) {
        if (block.type !== "tool-use") continue;
        if (!block.id || pending.has(block.id)) throw new Error(`Duplicate or empty tool call ID: ${block.id}`);
        pending.set(block.id, block);
      }
    } else {
      for (const block of message.content) {
        if (block.type !== "tool-result") continue;
        if (!pending.delete(block.toolUseId)) throw new Error(`Orphan tool result: ${block.toolUseId}`);
      }
      if (pending.size) throw new Error(`Unresolved tool calls: ${[...pending.keys()].join(", ")}`);
    }
  }
  if (pending.size) throw new Error(`Unresolved tool calls: ${[...pending.keys()].join(", ")}; reconcile their effects before resuming`);
}

/** Default boundaries start at real user input; durable workers can opt into balanced tool rounds. */
export function findSafeHistoryBoundary(messages: readonly ConversationMessage[], preferredIndex: number, allowToolRounds = false): number {
  for (let index = Math.max(1, preferredIndex); index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || (!allowToolRounds && (message.role !== "user" || message.content.some((block) => block.type === "tool-result")))) continue;
    try {
      assertBalancedToolHistory(messages.slice(0, index));
      assertBalancedToolHistory(messages.slice(index));
      return index;
    } catch { /* A user-role fragment alone does not establish a balanced boundary. */ }
  }
  return messages.length;
}
