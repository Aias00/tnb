import type { OpenAICompatibility } from "./config";
import { parseSseJson } from "./sse";
import { ProviderStreamError, streamWithRetry } from "./retry";
import type { ModelEvent, ModelRequest, ModelTransport, StopReason } from "./types";

export type OpenAIResponsesTransportOptions = {
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

export function createOpenAIResponsesTransport(
  options: OpenAIResponsesTransportOptions,
): ModelTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async *stream(request, signal) {
      yield* streamWithRetry(
        () => streamOpenAIResponses(fetcher, options, request, signal),
        { ...(signal ? { signal } : {}) },
      );
    },
  };
}

async function* streamOpenAIResponses(
  fetcher: FetchLike,
  options: OpenAIResponsesTransportOptions,
  request: ModelRequest,
  signal?: AbortSignal,
): AsyncGenerator<ModelEvent> {
  const response = await fetcher(
    `${options.baseUrl ?? "https://api.openai.com/v1"}/responses`,
    {
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
        store: false,
        ...(request.maxOutputTokens ?? options.maxOutputTokens
          ? {
              max_output_tokens: request.maxOutputTokens ?? Math.max(16, options.maxOutputTokens!),
            }
          : {}),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(options.reasoning && options.reasoningEffort && options.reasoningEffort !== "off"
          ? { reasoning: { effort: options.reasoningEffort, summary: "auto" } }
          : {}),
        input: toResponsesInput(request, options),
        ...(request.tools.length
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              })),
              ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
            }
          : {}),
      }),
      ...(signal ? { signal } : {}),
    },
  );

  let terminal = false;
  let sawToolCall = false;
  const toolCalls = new Map<number, { id: string; name: string; json: string }>();
  const reasoningIndexes = new Map<string, number>();
  for await (const value of parseSseJson(response, { signal })) {
    const event = value as ResponsesStreamEvent;
    if (event.type === "response.output_item.added" && event.item?.type === "reasoning") {
      const index = event.output_index ?? 0;
      if (event.item.id) reasoningIndexes.set(event.item.id, index);
      yield { type: "thinking", index, thinking: "" };
      continue;
    }
    if (
      (event.type === "response.reasoning_summary_text.delta" ||
        event.type === "response.reasoning_text.delta") &&
      typeof event.delta === "string"
    ) {
      yield { type: "thinking", index: event.output_index ?? 0, thinking: event.delta };
      continue;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      yield { type: "text", index: event.output_index ?? 0, text: event.delta };
      continue;
    }
    if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
      const index = event.output_index ?? 0;
      const id = event.item.call_id ?? event.item.id;
      if (!id || !event.item.name) throw new ProviderStreamError("OpenAI Responses tool call is missing an id or name");
      const json = event.item.arguments ?? "";
      toolCalls.set(index, { id, name: event.item.name, json });
      sawToolCall = true;
      yield { type: "tool-start", index, id, name: event.item.name };
      if (json) yield { type: "tool-input", index, json };
      continue;
    }
    if (
      event.type === "response.function_call_arguments.delta" &&
      typeof event.delta === "string"
    ) {
      const index = event.output_index ?? 0;
      const call = toolCalls.get(index);
      if (!call) throw new ProviderStreamError("OpenAI Responses tool input arrived before tool start");
      call.json += event.delta;
      yield { type: "tool-input", index, json: event.delta };
      continue;
    }
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      const index = event.output_index ?? 0;
      const existing = toolCalls.get(index);
      if (!existing) {
        const id = event.item.call_id ?? event.item.id;
        if (!id || !event.item.name) throw new ProviderStreamError("OpenAI Responses tool call is missing an id or name");
        const json = event.item.arguments ?? "";
        toolCalls.set(index, { id, name: event.item.name, json });
        sawToolCall = true;
        yield { type: "tool-start", index, id, name: event.item.name };
        if (json) yield { type: "tool-input", index, json };
      } else if (event.item.arguments?.startsWith(existing.json)) {
        const remainder = event.item.arguments.slice(existing.json.length);
        if (remainder) yield { type: "tool-input", index, json: remainder };
      }
      continue;
    }
    if (event.type === "response.output_item.done" && event.item?.type === "reasoning") {
      const index = event.output_index ?? 0;
      if (event.item.id) reasoningIndexes.set(event.item.id, index);
      yield {
        type: "thinking-signature",
        index,
        signature: JSON.stringify(event.item),
      };
      continue;
    }
    if (event.type === "response.completed") {
      for (const item of event.response?.output ?? []) {
        if (item.type !== "reasoning" || !item.id) continue;
        const index = reasoningIndexes.get(item.id);
        if (index === undefined) continue;
        yield { type: "thinking-signature", index, signature: JSON.stringify(item) };
      }
      terminal = true;
      if (event.response?.usage) yield { type: "usage", usage: responsesUsage(event.response.usage) };
      yield { type: "response-end", reason: sawToolCall ? "tool-use" : "end-turn" };
      continue;
    }
    if (event.type === "response.incomplete") {
      terminal = true;
      if (event.response?.usage) yield { type: "usage", usage: responsesUsage(event.response.usage) };
      yield {
        type: "response-end",
        reason: mapIncompleteReason(event.response?.incomplete_details?.reason),
      };
      continue;
    }
    if (event.type === "response.failed" || event.type === "error") {
      throw new ProviderStreamError(
        event.response?.error?.message ?? event.error?.message ?? "OpenAI Responses stream error",
        "server_error",
      );
    }
  }
  if (!terminal) throw new ProviderStreamError("OpenAI Responses stream ended without a terminal response");
}

function responsesUsage(usage: ResponsesUsage) {
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: cached,
    cacheCreationInputTokens: 0,
  };
}

function toResponsesInput(
  request: ModelRequest,
  options: OpenAIResponsesTransportOptions,
): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  if (request.systemPrompt) {
    input.push({
      role: options.reasoning && options.compat?.supportsDeveloperRole !== false
        ? "developer"
        : "system",
      content: request.systemPrompt,
    });
  }
  for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
    const message = request.messages[messageIndex]!;
    if (message.role === "assistant") {
      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
        const block = message.content[blockIndex]!;
        if (block.type === "text") {
          input.push({
            type: "message",
            id: `msg_tnb_${messageIndex}_${blockIndex}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: block.text, annotations: [] }],
          });
        } else if (block.type === "thinking") {
          if (block.signature) input.push(parseReasoningSignature(block.signature));
        } else {
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        }
      }
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool-result") {
        input.push({
          type: "function_call_output",
          call_id: block.toolUseId,
          output: block.content,
        });
      }
    }
    const ordinaryContent: Record<string, unknown>[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        ordinaryContent.push({ type: "input_text", text: block.text });
      } else if (block.type === "image") {
        ordinaryContent.push({
          type: "input_image",
          image_url: `data:${block.source.mediaType};base64,${block.source.data}`,
        });
      } else if (block.type === "document") {
        ordinaryContent.push({
          type: "input_file",
          filename: block.filename,
          file_data: `data:${block.source.mediaType};base64,${block.source.data}`,
        });
      }
    }
    if (ordinaryContent.length) input.push({ role: "user", content: ordinaryContent });
  }
  return input;
}

function parseReasoningSignature(signature: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(signature);
  } catch (error) {
    throw new Error("Invalid OpenAI Responses reasoning signature", { cause: error });
  }
  if (typeof value !== "object" || value === null || (value as { type?: unknown }).type !== "reasoning") {
    throw new Error("Invalid OpenAI Responses reasoning signature");
  }
  return value as Record<string, unknown>;
}

function mapIncompleteReason(reason: string | undefined): StopReason {
  return reason === "max_output_tokens" ? "max-tokens" : "end-turn";
}

type ResponsesStreamEvent = {
  type?: string;
  output_index?: number;
  delta?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    summary?: unknown;
    encrypted_content?: unknown;
  };
  response?: {
    incomplete_details?: { reason?: string } | null;
    error?: { message?: string } | null;
    output?: Array<{
      type?: string;
      id?: string;
      [key: string]: unknown;
    }>;
    usage?: ResponsesUsage;
  };
  error?: { message?: string };
};

type ResponsesUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
