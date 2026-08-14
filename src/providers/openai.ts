import type { ConversationMessage } from "../core/message";
import type { OpenAICompatibility } from "./config";
import { parseSseJson } from "./sse";
import { ProviderStreamError, streamWithRetry } from "./retry";
import type { ModelEvent, ModelRequest, ModelTransport, StopReason } from "./types";

export type OpenAITransportOptions = {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  maxOutputTokens?: number;
  compat?: OpenAICompatibility;
  reasoning?: boolean;
  reasoningEffort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  samplingParams?: Record<string, unknown>;
};

export function createOpenAITransport(options: OpenAITransportOptions): ModelTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async *stream(request, signal) {
      yield* streamWithRetry(
        () => streamOpenAI(fetcher, options, request, signal),
        { ...(signal ? { signal } : {}) },
      );
    },
  };
}

async function* streamOpenAI(
  fetcher: FetchLike,
  options: OpenAITransportOptions,
  request: ModelRequest,
  signal?: AbortSignal,
): AsyncGenerator<ModelEvent> {
      const response = await fetcher(`${options.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
        method: "POST",
        headers: {
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          "content-type": "application/json",
          ...options.headers,
        },
        body: JSON.stringify({
          ...options.samplingParams,
          model: request.model,
          stream: true,
          ...(options.compat?.supportsUsageInStreaming
            ? { stream_options: { include_usage: true } }
            : {}),
          ...(request.maxOutputTokens ?? options.maxOutputTokens
            ? {
                [options.compat?.maxTokensField ?? "max_completion_tokens"]:
                  request.maxOutputTokens ?? options.maxOutputTokens,
              }
            : {}),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.stopSequences === undefined ? {} : { stop: request.stopSequences }),
          ...reasoningRequestParameters(options),
          messages: [
            ...(request.systemPrompt
              ? [{
                  role: options.reasoning && options.compat?.supportsDeveloperRole
                    ? "developer"
                    : "system",
                  content: request.systemPrompt,
                }]
              : []),
            ...toOpenAIMessageHistory(request.messages, options.compat),
          ],
          ...(request.tools.length
            ? {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
                ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
              }
            : {}),
        }),
        ...(signal ? { signal } : {}),
      });

      let ended = false;
      const toolCalls = new Map<number, {
        id?: string;
        name?: string;
        started: boolean;
        pendingJson: string[];
      }>();
      for await (const value of parseSseJson(response)) {
        const chunk = value as OpenAIChunk;
        if (chunk.usage) {
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          yield {
            type: "usage",
            usage: {
              inputTokens: Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached),
              outputTokens: chunk.usage.completion_tokens ?? 0,
              cacheReadInputTokens: cached,
              cacheCreationInputTokens: 0,
            },
          };
        }
        for (const choice of chunk.choices ?? []) {
          if (typeof choice.delta?.content === "string" && choice.delta.content) {
            yield { type: "text", index: 0, text: choice.delta.content };
          }
          const reasoning = reasoningDelta(choice.delta);
          if (reasoning) yield { type: "thinking", index: 0, thinking: reasoning };
          for (const call of choice.delta?.tool_calls ?? []) {
            const index = call.index ?? 0;
            const state = toolCalls.get(index) ?? { started: false, pendingJson: [] };
            if (call.id) state.id = call.id;
            if (call.function?.name) state.name = call.function.name;
            if (call.function?.arguments) state.pendingJson.push(call.function.arguments);
            toolCalls.set(index, state);
            if (!state.started && state.id && state.name) {
              state.started = true;
              yield { type: "tool-start", index, id: state.id, name: state.name };
            }
            if (state.started) {
              for (const json of state.pendingJson.splice(0)) {
                yield { type: "tool-input", index, json };
              }
            }
          }
          if (choice.finish_reason) {
            const incompleteCall = [...toolCalls.entries()].find(([, state]) => !state.started);
            if (incompleteCall) {
              throw new ProviderStreamError(`OpenAI tool call ${incompleteCall[0]} ended without an id and name`);
            }
            ended = true;
            yield {
              type: "response-end",
              reason: mapOpenAIStop(choice.finish_reason, Boolean(request.stopSequences?.length)),
            };
          }
        }
      }
      if (!ended) throw new ProviderStreamError("OpenAI stream ended without a stop reason");
}

function reasoningRequestParameters(
  options: OpenAITransportOptions,
): Record<string, unknown> {
  if (!options.reasoning) return {};
  const effort = options.reasoningEffort;
  const enabled = Boolean(effort && effort !== "off");
  const supportedEffort = enabled && options.compat?.supportsReasoningEffort
    ? { reasoning_effort: effort }
    : {};
  if (options.compat?.thinkingFormat === "qwen") {
    return { enable_thinking: enabled, ...supportedEffort };
  }
  if (options.compat?.thinkingFormat === "deepseek") {
    return {
      thinking: { type: enabled ? "enabled" : "disabled" },
      ...supportedEffort,
    };
  }
  if (options.compat?.thinkingFormat === "openrouter") {
    return effort
      ? { reasoning: { effort: enabled ? effort : "none" } }
      : {};
  }
  return supportedEffort;
}

function toOpenAIMessages(
  message: ConversationMessage,
  compat: OpenAICompatibility | undefined,
  toolNames: ReadonlyMap<string, string>,
): Record<string, unknown>[] {
  if (message.role === "assistant") {
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    const reasoning = message.content
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking)
      .join("");
    const toolCalls = message.content
      .filter((block) => block.type === "tool-use")
      .map((block) => ({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      }));
    return [{
      role: "assistant",
      content: text || (compat?.requiresAssistantAfterToolResult ? "" : null),
      ...(compat?.requiresReasoningContentOnAssistantMessages ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    }];
  }
  const result: Record<string, unknown>[] = [];
  for (const block of message.content) {
    if (block.type === "tool-result") {
      const name = toolNames.get(block.toolUseId);
      result.push({
        role: "tool",
        tool_call_id: block.toolUseId,
        ...(compat?.requiresToolResultName && name ? { name } : {}),
        content: block.content,
      });
    }
  }
  const ordinaryContent: Record<string, unknown>[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      ordinaryContent.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      ordinaryContent.push({
        type: "image_url",
        image_url: { url: `data:${block.source.mediaType};base64,${block.source.data}` },
      });
    } else if (block.type === "document") {
      ordinaryContent.push({
        type: "file",
        file: {
          filename: block.filename,
          file_data: `data:${block.source.mediaType};base64,${block.source.data}`,
        },
      });
    }
  }
  if (ordinaryContent.length === 1 && ordinaryContent[0]?.type === "text") {
    result.push({ role: "user", content: ordinaryContent[0].text });
  } else if (ordinaryContent.length) {
    result.push({ role: "user", content: ordinaryContent });
  }
  return result;
}

function toOpenAIMessageHistory(
  messages: ConversationMessage[],
  compat: OpenAICompatibility | undefined,
): Record<string, unknown>[] {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "tool-use") toolNames.set(block.id, block.name);
    }
  }

  const result: Record<string, unknown>[] = [];
  let previousRole: unknown;
  for (const message of messages) {
    for (const converted of toOpenAIMessages(message, compat, toolNames)) {
      if (
        compat?.requiresAssistantAfterToolResult &&
        previousRole === "tool" &&
        converted.role === "user"
      ) {
        result.push({ role: "assistant", content: "I have processed the tool results." });
      }
      result.push(converted);
      previousRole = converted.role;
    }
  }
  return result;
}

function mapOpenAIStop(reason: string, requestedStopSequence = false): StopReason {
  if (reason === "tool_calls") return "tool-use";
  if (reason === "length") return "max-tokens";
  if (reason === "stop" && requestedStopSequence) return "stop-sequence";
  return "end-turn";
}

function reasoningDelta(delta: OpenAIDelta | undefined): string {
  if (!delta) return "";
  if (typeof delta.reasoning_content === "string") return delta.reasoning_content;
  if (typeof delta.reasoning === "string") return delta.reasoning;
  return (delta.reasoning_details ?? [])
    .map((detail) => detail.text ?? detail.summary ?? "")
    .join("");
}

type OpenAIDelta = NonNullable<NonNullable<OpenAIChunk["choices"]>[number]["delta"]>;

type OpenAIChunk = {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      reasoning_details?: Array<{ text?: string; summary?: string }>;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
