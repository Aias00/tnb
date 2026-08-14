import type { ConversationMessage, ToolResultBlock } from "../../core/message";
import type { PermissionChecker, ToolPolicy } from "../../core/permissions";
import type { ModelEvent, ModelRequest, ModelTransport, StopReason } from "../../providers/types";
import { McpRequestError } from "./client";

export type McpSamplingHandler = (
  params: unknown,
  signal: AbortSignal,
) => Promise<McpSamplingResult>;

export type McpSamplingResult = {
  role: "assistant";
  content: McpSamplingContent | McpSamplingContent[];
  model: string;
  stopReason: "endTurn" | "stopSequence" | "maxTokens" | "toolUse";
};

type McpSamplingContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

type ParsedSamplingRequest = {
  messages: ConversationMessage[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens: number;
  stopSequences?: string[];
  tools: ModelRequest["tools"];
  toolChoice?: ModelRequest["toolChoice"];
};

export function createMcpSamplingHandler(options: {
  serverName: string;
  transport: ModelTransport;
  model: string;
  authorize: PermissionChecker;
}): McpSamplingHandler {
  return async (params, signal) => {
    const request = parseSamplingRequest(params);
    const policy = samplingPolicy(options.serverName);
    const decision = await options.authorize(policy, {
      phase: "request",
      server: options.serverName,
      model: options.model,
      maxTokens: request.maxTokens,
      messages: describeMessagesForApproval(request.messages),
      toolNames: request.tools.map((tool) => tool.name),
      systemPrompt: request.systemPrompt,
    }, signal);
    if (decision.behavior === "deny") {
      throw new McpRequestError(-1, "User rejected sampling request");
    }
    const result = await collectSamplingResponse(
      options.transport,
      {
        model: options.model,
        messages: request.messages,
        tools: request.tools,
        maxOutputTokens: request.maxTokens,
        ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.stopSequences === undefined ? {} : { stopSequences: request.stopSequences }),
        ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
      },
      signal,
    );
    const responseDecision = await options.authorize(policy, {
      phase: "response",
      server: options.serverName,
      model: result.model,
      stopReason: result.stopReason,
      content: result.content,
    }, signal);
    if (responseDecision.behavior === "deny") {
      throw new McpRequestError(-1, "User rejected sampling response");
    }
    return result;
  };
}

export async function collectSamplingResponse(
  transport: ModelTransport,
  request: ModelRequest,
  signal: AbortSignal,
): Promise<McpSamplingResult> {
  signal.throwIfAborted();
  const blocks: Array<
    | { type: "text"; text: string }
    | { type: "tool"; id: string; name: string; json: string }
  > = [];
  const byIndex = new Map<number, number>();
  let stopReason: StopReason | undefined;
  let generatedText = "";
  let stopAt: number | undefined;

  for await (const event of transport.stream(request, signal)) {
    if (event.type === "thinking" || event.type === "thinking-signature") continue;
    if (event.type === "response-end") {
      stopReason = event.reason;
      break;
    }
    if (event.type === "usage") continue;
    if (event.type === "text") {
      const position = byIndex.get(event.index);
      if (position === undefined) {
        byIndex.set(event.index, blocks.length);
        blocks.push({ type: "text", text: event.text });
      } else {
        const block = blocks[position];
        if (!block || block.type !== "text") {
          throw new Error(`Model emitted text and tool data at content index ${event.index}`);
        }
        block.text += event.text;
      }
      generatedText += event.text;
      const match = firstStopSequence(generatedText, request.stopSequences);
      if (match !== undefined) {
        stopAt = match;
        stopReason = "stop-sequence";
        break;
      }
      continue;
    }
    if (event.type === "tool-start") {
      if (byIndex.has(event.index)) {
        throw new Error(`Model reused content index ${event.index}`);
      }
      byIndex.set(event.index, blocks.length);
      blocks.push({ type: "tool", id: event.id, name: event.name, json: "" });
      continue;
    }
    const position = byIndex.get(event.index);
    const block = position === undefined ? undefined : blocks[position];
    if (!block || block.type !== "tool") {
      throw new Error(`Model emitted tool input before tool start at content index ${event.index}`);
    }
    block.json += event.json;
  }

  if (!stopReason) throw new Error("Model stream ended without a stop reason");
  const content = toSamplingContent(blocks, stopAt);
  return {
    role: "assistant",
    content: content.length === 1 ? content[0]! : content,
    model: request.model,
    stopReason: toMcpStopReason(stopReason),
  };
}

function parseSamplingRequest(value: unknown): ParsedSamplingRequest {
  const request = objectValue(value, "sampling request");
  if (request.task !== undefined) {
    throw new McpRequestError(-32602, "Task-augmented sampling is not supported");
  }
  if (request.includeContext !== undefined && request.includeContext !== "none") {
    throw new McpRequestError(-32602, "MCP context inclusion is not supported");
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new McpRequestError(-32602, "Sampling messages must be a non-empty array");
  }
  if (!Number.isSafeInteger(request.maxTokens) || (request.maxTokens as number) <= 0) {
    throw new McpRequestError(-32602, "Sampling maxTokens must be a positive integer");
  }
  if (request.systemPrompt !== undefined && typeof request.systemPrompt !== "string") {
    throw new McpRequestError(-32602, "Sampling systemPrompt must be a string");
  }
  if (
    request.temperature !== undefined &&
    (typeof request.temperature !== "number" || !Number.isFinite(request.temperature))
  ) {
    throw new McpRequestError(-32602, "Sampling temperature must be a finite number");
  }
  const stopSequences = parseStopSequences(request.stopSequences);
  const tools = parseSamplingTools(request.tools);
  const toolChoice = parseToolChoice(request.toolChoice);
  if (toolChoice === "required" && tools.length === 0) {
    throw new McpRequestError(-32602, "Required tool choice needs at least one tool");
  }
  const messages = request.messages.map((message, index) =>
    parseSamplingMessage(message, index)
  );
  validateToolUseBalance(messages);
  return {
    messages,
    maxTokens: request.maxTokens as number,
    tools,
    ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt as string }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature as number }),
    ...(stopSequences === undefined ? {} : { stopSequences }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
  };
}

function parseSamplingMessage(value: unknown, index: number): ConversationMessage {
  const message = objectValue(value, `sampling message ${index}`);
  if (message.role !== "user" && message.role !== "assistant") {
    throw new McpRequestError(-32602, `Sampling message ${index} has an invalid role`);
  }
  const role = message.role;
  const values = Array.isArray(message.content) ? message.content : [message.content];
  if (values.some((block) => block === undefined)) {
    throw new McpRequestError(-32602, `Sampling message ${index} has no content`);
  }
  const parsed = values.map((block) => parseSamplingBlock(block, role, index));
  const hasToolResults = parsed.some((block) => block.type === "tool-result");
  if (hasToolResults && parsed.some((block) => block.type !== "tool-result")) {
    throw new McpRequestError(-32602, "Tool results cannot be mixed with other content");
  }
  return role === "user"
    ? {
        role: "user",
        content: parsed as Extract<ConversationMessage, { role: "user" }>["content"],
      }
    : {
        role: "assistant",
        content: parsed as Extract<ConversationMessage, { role: "assistant" }>["content"],
      };
}

function parseSamplingBlock(
  value: unknown,
  role: "user" | "assistant",
  messageIndex: number,
): ConversationMessage["content"][number] {
  const block = objectValue(value, `content in sampling message ${messageIndex}`);
  if (block.type === "text") {
    if (typeof block.text !== "string") invalidBlock(messageIndex, "text must be a string");
    return { type: "text", text: block.text as string };
  }
  if (block.type === "image") {
    if (role !== "user") invalidBlock(messageIndex, "image content is only supported in user messages");
    if (typeof block.data !== "string" || !block.data) invalidBlock(messageIndex, "image data is required");
    if (!isSupportedImageMimeType(block.mimeType)) invalidBlock(messageIndex, "image mimeType is unsupported");
    return {
      type: "image",
      source: { type: "base64", mediaType: block.mimeType, data: block.data },
    };
  }
  if (block.type === "tool_use") {
    if (role !== "assistant") invalidBlock(messageIndex, "tool_use requires the assistant role");
    if (typeof block.id !== "string" || !block.id) invalidBlock(messageIndex, "tool_use id is required");
    if (typeof block.name !== "string" || !block.name) invalidBlock(messageIndex, "tool_use name is required");
    const input = objectValue(block.input, "tool_use input");
    return { type: "tool-use", id: block.id as string, name: block.name as string, input };
  }
  if (block.type === "tool_result") {
    if (role !== "user") invalidBlock(messageIndex, "tool_result requires the user role");
    if (typeof block.toolUseId !== "string" || !block.toolUseId) {
      invalidBlock(messageIndex, "tool_result toolUseId is required");
    }
    if (!Array.isArray(block.content)) invalidBlock(messageIndex, "tool_result content must be an array");
    if (block.isError !== undefined && typeof block.isError !== "boolean") {
      invalidBlock(messageIndex, "tool_result isError must be boolean");
    }
    return {
      type: "tool-result",
      toolUseId: block.toolUseId as string,
      content: serializeToolResult(block.content as unknown[], block.structuredContent),
      isError: block.isError === true,
    };
  }
  invalidBlock(messageIndex, `unsupported content type ${String(block.type)}`);
}

function validateToolUseBalance(messages: ConversationMessage[]): void {
  const seen = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const uses = message.role === "assistant"
      ? message.content.filter((block) => block.type === "tool-use")
      : [];
    if (uses.length === 0) {
      if (message.content.some((block) => block.type === "tool-result")) {
        throw new McpRequestError(-32602, "Tool result has no immediately preceding tool use");
      }
      continue;
    }
    const ids = uses.map((block) => block.id);
    for (const id of ids) {
      if (seen.has(id)) throw new McpRequestError(-32602, `Duplicate tool use id: ${id}`);
      seen.add(id);
    }
    const next = messages[index + 1];
    if (!next || next.role !== "user" || next.content.some((block) => block.type !== "tool-result")) {
      throw new McpRequestError(-32602, "Tool result missing in sampling request");
    }
    const results = next.content as ToolResultBlock[];
    if (
      results.length !== ids.length ||
      new Set(results.map((result) => result.toolUseId)).size !== ids.length ||
      ids.some((id) => !results.some((result) => result.toolUseId === id))
    ) {
      throw new McpRequestError(-32602, "Tool results must match every preceding tool use exactly once");
    }
    index += 1;
  }
}

function parseSamplingTools(value: unknown): ModelRequest["tools"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new McpRequestError(-32602, "Sampling tools must be an array");
  const names = new Set<string>();
  return value.map((entry, index) => {
    const tool = objectValue(entry, `sampling tool ${index}`);
    if (typeof tool.name !== "string" || !tool.name) {
      throw new McpRequestError(-32602, `Sampling tool ${index} has no name`);
    }
    if (names.has(tool.name)) throw new McpRequestError(-32602, `Duplicate sampling tool: ${tool.name}`);
    names.add(tool.name);
    if (tool.description !== undefined && typeof tool.description !== "string") {
      throw new McpRequestError(-32602, `Sampling tool ${tool.name} description must be a string`);
    }
    return {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: objectValue(tool.inputSchema, `input schema for sampling tool ${tool.name}`),
    };
  });
}

function parseToolChoice(value: unknown): ModelRequest["toolChoice"] | undefined {
  if (value === undefined) return undefined;
  const choice = objectValue(value, "sampling toolChoice");
  if (choice.mode !== undefined && choice.mode !== "auto" && choice.mode !== "none" && choice.mode !== "required") {
    throw new McpRequestError(-32602, "Sampling toolChoice mode is invalid");
  }
  return (choice.mode ?? "auto") as ModelRequest["toolChoice"];
}

function parseStopSequences(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new McpRequestError(-32602, "Sampling stopSequences must contain non-empty strings");
  }
  return value as string[];
}

function serializeToolResult(content: unknown[], structuredContent: unknown): string {
  const textOnly = content.every((entry) => {
    const block = typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : undefined;
    return block?.type === "text" && typeof block.text === "string";
  });
  if (textOnly && structuredContent === undefined) {
    return content.map((entry) => (entry as { text: string }).text).join("\n");
  }
  return JSON.stringify({ content, ...(structuredContent === undefined ? {} : { structuredContent }) });
}

function toSamplingContent(
  blocks: Array<{ type: "text"; text: string } | { type: "tool"; id: string; name: string; json: string }>,
  stopAt: number | undefined,
): McpSamplingContent[] {
  let remainingText = stopAt;
  const content: McpSamplingContent[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      const text = remainingText === undefined ? block.text : block.text.slice(0, remainingText);
      if (text) content.push({ type: "text", text });
      if (remainingText !== undefined) remainingText = Math.max(0, remainingText - block.text.length);
      continue;
    }
    let input: unknown;
    try {
      input = block.json ? JSON.parse(block.json) : {};
    } catch (error) {
      throw new Error(`Model returned invalid JSON for tool ${block.name}`, { cause: error });
    }
    const objectInput = objectValue(input, `model input for tool ${block.name}`);
    content.push({ type: "tool_use", id: block.id, name: block.name, input: objectInput });
  }
  return content.length ? content : [{ type: "text", text: "" }];
}

function firstStopSequence(text: string, sequences: string[] | undefined): number | undefined {
  let first: number | undefined;
  for (const sequence of sequences ?? []) {
    const index = text.indexOf(sequence);
    if (index >= 0 && (first === undefined || index < first)) first = index;
  }
  return first;
}

function toMcpStopReason(reason: StopReason): McpSamplingResult["stopReason"] {
  if (reason === "tool-use") return "toolUse";
  if (reason === "max-tokens") return "maxTokens";
  if (reason === "stop-sequence") return "stopSequence";
  return "endTurn";
}

function samplingPolicy(serverName: string): ToolPolicy {
  return {
    name: `mcp__${serverName}__sampling`,
    risk: "network",
    isReadOnly: () => false,
    requiresApproval: () => true,
    permissionRuleContent: () => serverName,
  };
}

function describeMessagesForApproval(messages: ConversationMessage[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((block) => {
      if (block.type === "image") {
        return {
          type: "image",
          mimeType: block.source.mediaType,
          encodedBytes: block.source.data.length,
        };
      }
      return block;
    }),
  }));
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new McpRequestError(-32602, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function invalidBlock(messageIndex: number, message: string): never {
  throw new McpRequestError(-32602, `Sampling message ${messageIndex}: ${message}`);
}

function isSupportedImageMimeType(value: unknown): value is "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  return value === "image/jpeg" || value === "image/png" || value === "image/gif" || value === "image/webp";
}
