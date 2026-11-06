import { createServiceRef } from "./services";

export type ChatSummary = { id: string; title: string; workspace: string; provider: string; model: string; createdAt: number; updatedAt: number;
  status: "idle" | "running" | "waiting-approval" | "interrupted" | "failed"; turnId?: string; messageCount: number; error?: string };
export type ChatMessage = { id: string; thread: string; role: "user" | "assistant"; text: string; at: number; status: "complete" | "running" | "interrupted" | "failed";
  tools?: Array<{ id: string; name: string; status: string; output?: string; phase?: string; latestTool?: string; elapsedSeconds?: number; exitCode?: number }> };
export type ChatApproval = { requestId: string; turnId: string; tool: string; input: string; message: string };
export type ChatActivity = { phase: "requesting" | "thinking" | "responding" | "preparing-tool" | "tool" | "retrying" | "waiting-approval" | "cancelling"; startedAt: number; tool?: string; retry?: number; retryAt?: number };
export type ChatHistoryPage = { messages: ChatMessage[]; earlierMessages: number };
export type ChatSnapshot = { chat: ChatSummary; messages: ChatMessage[]; approvals: ChatApproval[]; earlierMessages: number; activity?: ChatActivity };
/** Workspace is fixed by the host. Browser input cannot supply runtime configuration or credentials. */
export type WorkspaceChatService = { readonly workspace: string; list(): ChatSummary[]; detail(chatId: string): ChatSnapshot;
  page?(chatId: string, before: string): ChatHistoryPage;
  inspect?(input: import("../services/workbench/inspection").InspectionRequest, signal?: AbortSignal): Promise<import("../services/workbench/inspection").InspectionView>;
  search?(query: string, signal?: AbortSignal): Promise<{ matches: Array<{ file: string; line: number; text: string; preview: string[] }>; truncated: boolean }>;
  command(input: unknown): Promise<unknown>; watch(chatId: string, signal: AbortSignal, onClose?: () => void): Response };
export type ChatService = { open(workspace: string): Promise<WorkspaceChatService> };
export const CHAT_SERVICE = "tnb.chat/v1";
export const CHAT_SERVICE_REF = createServiceRef<ChatService>({ id: "tnb.chat", version: 1, scope: "host", methods: { open: true } });
