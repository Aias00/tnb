/** Headless execution kernel: importing this entrypoint never loads CLI, TUI or coding tools. */
export { runAgentLoop } from "../core/agent-loop";
export type { AgentLoopOptions, AgentCompactionResult, AuthorizationDecision, ToolExecutionEvent } from "../core/agent-loop";
export { defineTool } from "../core/tool";
export type { AgentTool, ToolDefinition, ToolExecutionContext, ToolCapability, ToolEffects } from "../core/tool";
export { executeTool } from "../core/tool-runtime";
export type { ConversationMessage, ToolUseBlock, ToolResultBlock, MediaBlock } from "../core/message";
export type { ModelTransport, ModelRequest, ModelEvent, TokenUsage } from "../providers/types";
export type { ToolCallJournal, JournalOutcome } from "../core/call-journal";
export { createDeferredToolCatalog } from "../core/tool-search";
export type { ToolCatalog, DeferredToolCatalog } from "../core/tool-search";
