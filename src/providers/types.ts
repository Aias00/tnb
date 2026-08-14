import type { ConversationMessage } from "../core/message";

export type StopReason = "end-turn" | "tool-use" | "max-tokens" | "stop-sequence" | "cancelled";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd?: number;
};

export type ModelEvent =
  | { type: "text"; index: number; text: string }
  | { type: "thinking"; index: number; thinking: string }
  | { type: "thinking-signature"; index: number; signature: string }
  | { type: "tool-start"; index: number; id: string; name: string }
  | { type: "tool-input"; index: number; json: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "response-end"; reason: StopReason };

export type ModelRequest = {
  model: string;
  speed?: "fast";
  systemPrompt?: string;
  maxOutputTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  toolChoice?: "auto" | "none" | "required";
  messages: ConversationMessage[];
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
};

export interface ModelTransport {
  stream(request: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelEvent>;
}
