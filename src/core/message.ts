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
  content: string;
  isError: boolean;
};

export type ConversationMessage =
  | { role: "user"; content: Array<TextBlock | ToolResultBlock | MediaBlock> }
  | { role: "assistant"; content: Array<TextBlock | ThinkingBlock | ToolUseBlock> };
