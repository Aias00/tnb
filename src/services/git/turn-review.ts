import type { ConversationMessage } from "../../core/message";
import type { FileChangeEvidence } from "../../core/tool";
export type TurnReview = { turn: number; prompt: string; changes: FileChangeEvidence[]; observations: import("../../core/tool").WorkspaceObservation[]; unattributed: number };
/** Native results are evidence; current working-tree state is deliberately never consulted. */
export function reviewTurns(messages: ConversationMessage[]): TurnReview[] {
  const turns: TurnReview[] = []; let current: TurnReview | undefined;
  const calls = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "user" && message.content.some(block => block.type === "text") && !message.content.some(block => block.type === "tool-result")) {
      current = { turn: turns.length + 1, prompt: message.content.filter(block => block.type === "text").map(block => block.text).join("\n"), changes: [], observations: [], unattributed: 0 }; turns.push(current);
    }
    for (const block of message.content) {
      if (block.type === "tool-use") calls.set(block.id, block.name);
      if (block.type === "tool-result" && current) {
        if (block.fileChanges) current.changes.push(...block.fileChanges);
        if (block.workspaceObservations) current.observations.push(...block.workspaceObservations);
        if (["bash", "shell", "edit", "write"].includes(calls.get(block.toolUseId) ?? "") && !block.fileChanges?.length) current.unattributed++;
      }
    }
  }
  return turns;
}
