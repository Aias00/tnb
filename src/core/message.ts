export type TextBlock = { type: "text"; text: string };
export type ImageBlock = {
  type: "image";
  source: {
    type: "base64";
    mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string;
  };
};
export type DocumentBlock = {
  type: "document";
  source: {
    type: "base64";
    mediaType: "application/pdf";
    data: string;
  };
  filename: string;
};
export type MediaBlock = ImageBlock | DocumentBlock;
export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
};
export type ToolUseBlock = {
  type: "tool-use";
  id: string;
  name: string;
  input: unknown;
};
export type ToolResultBlock = {
  type: "tool-result";
  toolUseId: string;
  fileChanges?: import("./tool").FileChangeEvidence[];
  workspaceObservations?: import("./tool").WorkspaceObservation[];
  content: string;
  isError: boolean;
};

export type ConversationMessage =
  | { role: "user"; content: Array<TextBlock | ToolResultBlock | MediaBlock>; promptInput?: PersistedPromptInput }
  | { role: "assistant"; content: Array<TextBlock | ThinkingBlock | ToolUseBlock> };
import type { PersistedPromptInput } from "./prompt-input";

/** Local review evidence is not model context and must not affect request budgeting. */
export function withoutFileChangeEvidence(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.map(message => message.role === "user" ? { ...message, content: message.content.map(block => {
    if (block.type !== "tool-result" || !block.fileChanges && !block.workspaceObservations) return block;
    const { fileChanges: _evidence, workspaceObservations: _observations, ...content } = block; return content;
  }) } : message);
}
