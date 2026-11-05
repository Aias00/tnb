import type { ConversationMessage } from "../../core/message";

export type TaskProgress = {
  deliveryIndex: number;
  pending: Array<{ id: string; name: string }>;
  recent: Array<{ id: string; name: string; isError: boolean; outputHint: string }>;
};

/** Execution receipts, not model claims of business completion or new authority. */
export function advanceTaskProgress(previous: TaskProgress | undefined, messages: ConversationMessage[], deliveryIndex: number): TaskProgress {
  const next = structuredClone(previous ?? { deliveryIndex: -1, pending: [], recent: [] });
  if (next.deliveryIndex >= deliveryIndex) return next;
  for (const message of messages) for (const block of message.content) {
    if (block.type === "tool-use") next.pending.push({ id: block.id, name: block.name });
    if (block.type === "tool-result") {
      const call = next.pending.find((item) => item.id === block.toolUseId);
      next.recent.push({ id: block.toolUseId, name: call?.name ?? "tool", isError: block.isError, outputHint: block.content.slice(0, 256) });
      next.pending = next.pending.filter((item) => item.id !== block.toolUseId);
    }
  }
  next.pending = next.pending.slice(-64);
  next.recent = next.recent.slice(-6);
  next.deliveryIndex = deliveryIndex;
  return next;
}
