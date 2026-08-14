import type { ConversationMessage } from "../core/message";
import { getApiModelId, getModelCapabilities, usesOneMillionContext } from "./models";
import { parseSseJson } from "./sse";
import { ProviderStreamError, streamWithRetry } from "./retry";
import type { ModelEvent, ModelRequest, ModelTransport, StopReason, TokenUsage } from "./types";

export type AnthropicTransportOptions = {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  maxOutputTokens?: number;
  promptCaching?: false | "5m" | "1h";
  requiredToolChoice?: "any" | "auto";
};

export function createAnthropicTransport(options: AnthropicTransportOptions): ModelTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async *stream(request, signal) {
      yield* streamWithRetry(
        () => streamAnthropic(fetcher, options, request, signal),
        { ...(signal ? { signal } : {}) },
      );
    },
  };
}

async function* streamAnthropic(
  fetcher: FetchLike,
  options: AnthropicTransportOptions,
  request: ModelRequest,
  signal?: AbortSignal,
): AsyncGenerator<ModelEvent> {
      const response = await fetcher(`${options.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
          ...(anthropicBetaHeader(request) ? { "anthropic-beta": anthropicBetaHeader(request)! } : {}),
          ...options.headers,
        },
        body: JSON.stringify({
          model: getApiModelId(request.model),
          ...(request.speed === "fast" ? { speed: "fast" } : {}),
          max_tokens: request.maxOutputTokens ?? options.maxOutputTokens ?? getModelCapabilities(request.model).maxOutputTokens,
          stream: true,
          ...(options.promptCaching
            ? {
                cache_control: {
                  type: "ephemeral",
                  ...(options.promptCaching === "1h" ? { ttl: "1h" } : {}),
                },
              }
            : {}),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.stopSequences === undefined ? {} : { stop_sequences: request.stopSequences }),
          ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
          messages: request.messages.map(toAnthropicMessage),
          ...(request.tools.length
            ? {
                tools: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.inputSchema,
                })),
                ...(request.toolChoice
                  ? {
                      tool_choice: anthropicToolChoice(
                        request.toolChoice,
                        request.tools,
                        options.requiredToolChoice,
                      ),
                    }
                  : {}),
              }
            : {}),
        }),
        ...(signal ? { signal } : {}),
      });

      let ended = false;
      let sawToolUse = false;
      const reportedUsage = emptyTokenUsage();
      for await (const value of parseSseJson(response)) {
        const event = value as AnthropicEvent;
        if (event.type === "message_start" && event.message?.usage) {
          const usage = anthropicUsageDelta(reportedUsage, event.message.usage, false);
          if (usage) yield { type: "usage", usage };
        } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          sawToolUse = true;
          yield { type: "tool-start", index: event.index, id: event.content_block.id, name: event.content_block.name };
        } else if (event.type === "content_block_start" && event.content_block?.type === "text" && event.content_block.text) {
          yield { type: "text", index: event.index, text: event.content_block.text };
        } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          yield { type: "text", index: event.index, text: event.delta.text ?? "" };
        } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          yield { type: "tool-input", index: event.index, json: event.delta.partial_json ?? "" };
        } else if (event.type === "message_delta") {
          if (event.usage) {
            const usage = anthropicUsageDelta(reportedUsage, event.usage, true);
            if (usage) yield { type: "usage", usage };
          }
          if (event.delta?.stop_reason) {
            ended = true;
            yield {
              type: "response-end",
              reason: mapAnthropicStop(event.delta.stop_reason, event.delta.stop_sequence),
            };
          }
        } else if (event.type === "message_stop" && !ended) {
          // Anthropic emits the stop reason in message_delta before message_stop.
          // Some compatible gateways omit that delta but still emit the protocol's
          // explicit message_stop terminator. Preserve strict EOF handling while
          // accepting that grounded terminal event and infer only the broad outcome.
          ended = true;
          yield { type: "response-end", reason: sawToolUse ? "tool-use" : "end-turn" };
        } else if (event.type === "error") {
          throw new ProviderStreamError(event.error?.message ?? "Anthropic stream error", "server_error");
        }
      }
      if (!ended) throw new ProviderStreamError("Anthropic stream ended without a stop reason");
}

function anthropicToolChoice(
  choice: NonNullable<ModelRequest["toolChoice"]>,
  tools: ModelRequest["tools"],
  requiredMode: "any" | "auto" = "any",
): Record<string, string> {
  if (choice === "required") {
    return tools.length === 1
      ? { type: "tool", name: tools[0]!.name }
      : { type: requiredMode };
  }
  return { type: choice };
}

function anthropicBetaHeader(request: ModelRequest): string | undefined {
  const values = [
    usesOneMillionContext(request.model) ? "context-1m-2025-08-07" : undefined,
    request.speed === "fast" ? "fast-mode-2026-02-01" : undefined,
  ].filter((value): value is string => value !== undefined);
  return values.length ? values.join(",") : undefined;
}

function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

function anthropicUsageDelta(
  reported: TokenUsage,
  usage: AnthropicUsage,
  includeOutput: boolean,
): TokenUsage | undefined {
  const delta = emptyTokenUsage();
  delta.inputTokens = cumulativeUsageDelta(reported, "inputTokens", usage.input_tokens);
  delta.cacheReadInputTokens = cumulativeUsageDelta(
    reported,
    "cacheReadInputTokens",
    usage.cache_read_input_tokens,
  );
  delta.cacheCreationInputTokens = cumulativeUsageDelta(
    reported,
    "cacheCreationInputTokens",
    usage.cache_creation_input_tokens,
  );
  if (includeOutput) {
    // message_start contains an initial cumulative output count; message_delta
    // contains the final count, so output is emitted only from terminal deltas.
    delta.outputTokens = cumulativeUsageDelta(reported, "outputTokens", usage.output_tokens);
  }
  return Object.values(delta).some((value) => value > 0) ? delta : undefined;
}

function cumulativeUsageDelta(
  reported: TokenUsage,
  field: Exclude<keyof TokenUsage, "costUsd">,
  value: number | undefined,
): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  const delta = Math.max(0, value - reported[field]);
  reported[field] = Math.max(reported[field], value);
  return delta;
}

function toAnthropicMessage(message: ConversationMessage): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "tool-use") {
      content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    } else if (block.type === "tool-result") {
      content.push({
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      });
    } else if (block.type === "image") {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: block.source.mediaType,
          data: block.source.data,
        },
      });
    } else if (block.type === "document") {
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: block.source.mediaType,
          data: block.source.data,
        },
      });
    }
  }
  return {
    role: message.role,
    content,
  };
}

function mapAnthropicStop(reason: string, stopSequence?: string | null): StopReason {
  if (reason === "tool_use") return "tool-use";
  if (reason === "max_tokens") return "max-tokens";
  if (reason === "stop_sequence" || stopSequence) return "stop-sequence";
  return "end-turn";
}

type AnthropicEvent = {
  type?: string;
  index: number;
  content_block?: { type?: string; id: string; name: string; text?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
    stop_sequence?: string | null;
  };
  error?: { type?: string; message?: string };
  message?: { usage?: AnthropicUsage };
  usage?: AnthropicUsage;
};

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
