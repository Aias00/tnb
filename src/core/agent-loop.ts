import type {
  ConversationMessage,
  MediaBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "./message";
import type { AgentTool, ToolProgressData } from "./tool";
import { executeTool } from "./tool-runtime";
import { assertBalancedToolHistory } from "./history";
import { toolCallScope, type ToolCallJournal } from "./call-journal";
import type { ToolCatalog } from "./tool-search";
import type { ModelEvent, ModelTransport, StopReason, TokenUsage } from "../providers/types";
import { addUsage, EMPTY_USAGE } from "../services/usage/cost";
import type { PersistedPromptInput } from "./prompt-input";

export const DEFAULT_SUBAGENT_MAX_TURNS = 200;
export const MAX_OUTPUT_TOKEN_RECOVERIES = 3;

export type AuthorizationDecision =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };

export type AgentCompactionResult = {
  compacted: boolean;
  messages: ConversationMessage[];
  preTokens: number;
  postTokens: number;
};

export type ToolExecutionEvent =
  | { type: "tool-execution-start"; id: string; name: string; input: unknown; startedAt: number }
  | { type: "tool-execution-progress"; id: string; name: string; data: ToolProgressData }
  | {
      type: "tool-execution-end";
      id: string;
      name: string;
      output: string;
      isError: boolean;
      durationMs: number;
    };

export type AgentLoopOptions = {
  transport: ModelTransport;
  model: string;
  prompt: string | Array<TextBlock | MediaBlock>;
  promptInput?: PersistedPromptInput;
  messages?: ConversationMessage[];
  systemPrompt?: string | (() => string);
  tools: AgentTool[];
  callJournal?: ToolCallJournal;
  /** Revision/identity snapshot of mutable session authority; compared after awaits. */
  executionContext?(): unknown;
  resolveTools?(): AgentTool[];
  toolCatalog?: ToolCatalog;
  authorize(
    tool: AgentTool,
    input: unknown,
    context: { toolUseId: string; preApproved?: boolean },
  ): Promise<AuthorizationDecision>;
  onEvent?(event: ModelEvent): void;
  onToolEvent?(event: ToolExecutionEvent): void;
  onMessage?(message: ConversationMessage, context?: { stopReason?: StopReason }): void | Promise<void>;
  compactMessages?(
    messages: ConversationMessage[],
    signal: AbortSignal,
    context?: { reason: "threshold" | "context-overflow" },
  ): Promise<AgentCompactionResult>;
  onCompact?(result: AgentCompactionResult): void | Promise<void>;
  beforePrompt?(prompt: string | Array<TextBlock | MediaBlock>): Promise<{
    prompt?: string | Array<TextBlock | MediaBlock>;
    context?: string[];
  }>;
  beforeTurn?(): Promise<{ context?: string[] }>;
  beforeTool?(event: { id: string; name: string; input: unknown }): Promise<{
    input?: unknown;
    decision?: AuthorizationDecision;
    context?: string[];
  }>;
  afterTool?(event: {
    id: string;
    name: string;
    input: unknown;
    output: string;
    isError: boolean;
  }): Promise<{ context?: string[] }>;
  onStop?(event: {
    stopReason: Exclude<StopReason, "tool-use">;
    stopHookActive: boolean;
    lastAssistantMessage?: string;
  }): Promise<{
    feedback?: string;
  }>;
  signal?: AbortSignal;
  maxTurns?: number;
};

export async function runAgentLoop(options: AgentLoopOptions): Promise<{
  messages: ConversationMessage[];
  stopReason: Exclude<StopReason, "tool-use">;
  usage: TokenUsage;
}> {
  assertBalancedToolHistory(options.messages ?? []);
  const signal = options.signal ?? new AbortController().signal;
  const maxTurns = options.maxTurns;
  const messages: ConversationMessage[] = structuredClone(options.messages ?? []);
  const processedPrompt = options.beforePrompt
    ? await options.beforePrompt(structuredClone(options.prompt))
    : {};
  const prompt = appendContext(processedPrompt.prompt ?? options.prompt, processedPrompt.context);
  const promptMessage: ConversationMessage = {
    role: "user",
    content: typeof prompt === "string"
      ? [{ type: "text", text: prompt }]
      : structuredClone(prompt),
    ...(options.promptInput ? { promptInput: structuredClone(options.promptInput) } : {}),
  };
  const lastMessage = messages.at(-1);
  if (lastMessage?.role === "user" && !options.promptInput) lastMessage.content.push(...structuredClone(promptMessage.content));
  else messages.push(promptMessage);
  await options.onMessage?.(structuredClone(promptMessage));
  let outputTokenRecoveries = 0;
  let contextOverflowRecoveries = 0;
  let stopHookActive = false;
  let totalUsage: TokenUsage = { ...EMPTY_USAGE };

  for (let turn = 0; maxTurns === undefined || turn < maxTurns; turn += 1) {
    signal.throwIfAborted();
    const turnContext = await options.beforeTurn?.();
    if (turnContext?.context?.length) {
      const message: ConversationMessage = {
        role: "user",
        content: [{ type: "text", text: turnContext.context.join("\n\n") }],
      };
      messages.push(message);
      await options.onMessage?.(structuredClone(message));
    }
    if (options.compactMessages) {
      const compacted = await options.compactMessages(structuredClone(messages), signal, { reason: "threshold" });
      if (compacted.compacted) {
        messages.splice(0, messages.length, ...structuredClone(compacted.messages));
        await options.onCompact?.(structuredClone(compacted));
      }
    }
    assertBalancedToolHistory(messages);
    const currentTools = options.resolveTools?.() ?? options.tools;
    if (options.resolveTools) options.toolCatalog?.replaceTools?.(currentTools);
    const availableTools = options.toolCatalog?.listTools() ?? currentTools;
    const blocks = new Map<
      number,
      | { kind: "text"; text: string }
      | { kind: "thinking"; thinking: string; signature?: string }
      | { kind: "tool"; id: string; name: string; json: string }
    >();
    let stopReason: StopReason | undefined;

    for (;;) {
      blocks.clear();
      stopReason = undefined;
      try {
        for await (const event of options.transport.stream(
          {
            model: options.model,
            ...(options.systemPrompt
              ? { systemPrompt: typeof options.systemPrompt === "function" ? options.systemPrompt() : options.systemPrompt }
              : {}),
            messages: providerMessages(messages),
            tools: availableTools.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          },
          signal,
        )) {
          signal.throwIfAborted();
          options.onEvent?.(event);
          if (event.type === "usage") {
            totalUsage = addUsage(totalUsage, event.usage);
          } else if (event.type === "text") {
            const current = blocks.get(event.index);
            if (current && current.kind !== "text") throw new Error("Stream block type changed");
            blocks.set(event.index, { kind: "text", text: `${current?.text ?? ""}${event.text}` });
          } else if (event.type === "thinking") {
            const current = blocks.get(event.index);
            if (current && current.kind !== "thinking") throw new Error("Stream block type changed");
            blocks.set(event.index, {
              kind: "thinking",
              thinking: `${current?.thinking ?? ""}${event.thinking}`,
              ...(current?.signature ? { signature: current.signature } : {}),
            });
          } else if (event.type === "thinking-signature") {
            const current = blocks.get(event.index);
            if (!current || current.kind !== "thinking") throw new Error("Thinking signature arrived before thinking block");
            current.signature = event.signature;
          } else if (event.type === "tool-start") {
            blocks.set(event.index, { kind: "tool", id: event.id, name: event.name, json: "" });
          } else if (event.type === "tool-input") {
            const current = blocks.get(event.index);
            if (!current || current.kind !== "tool") throw new Error("Tool input arrived before tool start");
            current.json += event.json;
          } else if (event.type === "response-end") {
            stopReason = event.reason;
          }
        }
        contextOverflowRecoveries = 0;
        break;
      } catch (error) {
        signal.throwIfAborted();
        if (!options.compactMessages || !isContextOverflowError(error) || contextOverflowRecoveries >= 3) throw error;
        const compacted = await options.compactMessages(
          structuredClone(messages),
          signal,
          { reason: "context-overflow" },
        );
        if (!compacted.compacted || compacted.postTokens >= compacted.preTokens) throw error;
        contextOverflowRecoveries += 1;
        messages.splice(0, messages.length, ...structuredClone(compacted.messages));
        await options.onCompact?.(structuredClone(compacted));
      }
    }

    if (!stopReason) throw new Error("Model stream ended without a stop reason");
    const content = [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => {
        if (block.kind === "text") return { type: "text", text: block.text } as const;
        if (block.kind === "thinking") {
          return {
            type: "thinking",
            thinking: block.thinking,
            ...(block.signature ? { signature: block.signature } : {}),
          } as const;
        }
        if (stopReason === "max-tokens" || stopReason === "cancelled") return undefined;
        return {
          type: "tool-use",
          id: block.id,
          name: block.name,
          input: parseInput(block.name, block.json),
        } as const;
      }).filter((block): block is NonNullable<typeof block> => block !== undefined);
    const assistantMessage: ConversationMessage = { role: "assistant", content };
    const callIds = new Set<string>();
    for (const block of content) {
      if (block.type !== "tool-use") continue;
      if (!block.id || callIds.has(block.id)) throw new Error(`Duplicate or empty tool call ID: ${block.id}`);
      callIds.add(block.id);
    }
    if (content.length) {
      messages.push(assistantMessage);
      await options.onMessage?.(structuredClone(assistantMessage), { stopReason });
    }
    if (stopReason === "max-tokens" && outputTokenRecoveries < MAX_OUTPUT_TOKEN_RECOVERIES) {
      outputTokenRecoveries += 1;
      const recoveryMessage: ConversationMessage = {
        role: "user",
        content: [
          {
            type: "text",
            text: "Continue directly from where the response stopped. Do not apologize or repeat the completed portion. Split the remaining work into smaller pieces if needed.",
          },
        ],
      };
      messages.push(recoveryMessage);
      await options.onMessage?.(structuredClone(recoveryMessage));
      continue;
    }
    if (stopReason !== "tool-use") {
      const lastAssistantMessage = content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      const stopResult = await options.onStop?.({
        stopReason,
        stopHookActive,
        ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
      });
      if (stopResult?.feedback) {
        stopHookActive = true;
        const feedback: ConversationMessage = {
          role: "user",
          content: [{ type: "text", text: stopResult.feedback }],
        };
        messages.push(feedback);
        await options.onMessage?.(structuredClone(feedback));
        continue;
      }
      return { messages, stopReason, usage: totalUsage };
    }

    const results: Array<ToolResultBlock | MediaBlock> = [];
    const scope = options.callJournal ? options.callJournal.scope?.(messages) ?? toolCallScope(messages) : undefined;
    for (const use of content.filter((block): block is ToolUseBlock => block.type === "tool-use")) {
      const outcome = await executeTool(use, { ...options, tools: availableTools, toolCatalog: undefined }, signal, scope);
      results.push(outcome.result, ...outcome.attachments);
    }
    if (results.length === 0) throw new Error("Model requested tool use without a tool call");
    const resultMessage: ConversationMessage = { role: "user", content: results };
    messages.push(resultMessage);
    await options.onMessage?.(structuredClone(resultMessage));
  }

  throw new Error(`Maximum turn count (${maxTurns}) exceeded`);
}

function providerMessages(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.map((message) => {
    if (message.role !== "user" || message.promptInput === undefined) return structuredClone(message);
    return { role: "user", content: structuredClone(message.content) };
  });
}

function isContextOverflowError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = `${error.name} ${error.message}`.toLowerCase();
  return [
    "context length", "context window", "maximum context", "too many tokens",
    "prompt is too long", "request too large", "input length",
  ].some((fragment) => message.includes(fragment));
}

function parseInput(name: string, json: string): unknown {
  try {
    return JSON.parse(json || "{}");
  } catch (error) {
    throw new Error(`Tool ${name} emitted invalid JSON input`, { cause: error });
  }
}


function appendContext(
  prompt: string | Array<TextBlock | MediaBlock>,
  context: string[] | undefined,
): string | Array<TextBlock | MediaBlock> {
  if (!context?.length) return prompt;
  const text = context.join("\n\n");
  if (typeof prompt === "string") return `${prompt}\n\n<hook-context>\n${text}\n</hook-context>`;
  return [...prompt, { type: "text", text: `\n\n<hook-context>\n${text}\n</hook-context>` }];
}
