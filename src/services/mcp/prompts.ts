import { basename } from "node:path";

import type { MediaBlock, TextBlock } from "../../core/message";
import type { McpClient, McpPromptDefinition, McpResourceContent } from "./client";
import { buildMcpToolName } from "./tools";

export type McpPromptCommand = {
  name: string;
  serverName: string;
  definition: McpPromptDefinition;
};

export type McpPromptInputCompletion = {
  values: string[];
  replaceStart: number;
  replaceEnd: number;
};

export function createMcpPromptCommands(
  serverName: string,
  definitions: McpPromptDefinition[],
): McpPromptCommand[] {
  const names = new Set<string>();
  return definitions.map((definition) => {
    const name = buildMcpToolName(serverName, definition.name);
    if (names.has(name)) throw new Error(`MCP prompt name collision: ${name}`);
    names.add(name);
    return { name, serverName, definition };
  });
}

export async function expandMcpPromptInput(
  input: string,
  commands: readonly McpPromptCommand[],
  clients: Readonly<Record<string, McpClient>>,
  signal?: AbortSignal,
): Promise<Array<TextBlock | MediaBlock> | undefined> {
  if (!input.startsWith("/")) return undefined;
  const [commandName, ...argumentValues] = input.slice(1).trim().split(/\s+/);
  if (!commandName) return undefined;
  const command = commands.find((candidate) => candidate.name === commandName);
  if (!command) return undefined;
  const client = clients[command.serverName];
  if (!client) throw new Error(`MCP server is not connected: ${command.serverName}`);
  const argumentsByName = mapPromptArguments(command.definition, argumentValues);
  const result = await client.getPrompt(command.definition.name, argumentsByName, signal);
  const blocks: Array<TextBlock | MediaBlock> = [];
  for (const message of result.messages) {
    blocks.push(...promptContentToBlocks(message.content));
  }
  if (blocks.length === 0) throw new Error(`MCP prompt ${commandName} returned no supported content`);
  return blocks;
}

export async function completeMcpPromptInput(
  input: string,
  commands: readonly McpPromptCommand[],
  clients: Readonly<Record<string, McpClient>>,
  signal?: AbortSignal,
): Promise<McpPromptInputCompletion | undefined> {
  const commandMatch = input.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!commandMatch) return undefined;
  const command = commands.find((candidate) => candidate.name === commandMatch[1]);
  if (!command) return undefined;
  const declared = command.definition.arguments ?? [];
  if (!declared.length) return undefined;
  const rawArguments = commandMatch[2] ?? "";
  const completedValues = rawArguments.trim() ? rawArguments.trim().split(/\s+/) : [];
  const startsNewArgument = /\s$/.test(input);
  const argumentIndex = startsNewArgument ? completedValues.length : Math.max(0, completedValues.length - 1);
  const argument = declared[argumentIndex];
  if (!argument) return undefined;
  const value = startsNewArgument ? "" : completedValues[argumentIndex] ?? "";
  const context = Object.fromEntries(
    declared.slice(0, argumentIndex).flatMap((definition, index) =>
      completedValues[index] === undefined ? [] : [[definition.name, completedValues[index]!]]
    ),
  );
  const client = clients[command.serverName];
  if (!client) return undefined;
  const completion = await client.completeArgument(
    { type: "ref/prompt", name: command.definition.name },
    { name: argument.name, value },
    context,
    signal,
  );
  const replaceStart = startsNewArgument ? input.length : input.lastIndexOf(value);
  return {
    values: completion.values.map((candidate) => `${input.slice(0, replaceStart)}${candidate}${input.slice(input.length)}`),
    replaceStart,
    replaceEnd: input.length,
  };
}

function mapPromptArguments(
  definition: McpPromptDefinition,
  values: string[],
): Record<string, string> {
  const declared = definition.arguments ?? [];
  const required = declared.filter((argument) => argument.required);
  if (values.length < required.length) {
    throw new Error(
      `MCP prompt ${definition.name} requires arguments: ${required.map((argument) => argument.name).join(", ")}`,
    );
  }
  if (values.length > declared.length) {
    throw new Error(`MCP prompt ${definition.name} accepts ${declared.length} argument(s)`);
  }
  return Object.fromEntries(
    declared.slice(0, values.length).map((argument, index) => [argument.name, values[index]!]),
  );
}

function promptContentToBlocks(content: Record<string, unknown>): Array<TextBlock | MediaBlock> {
  if (content.type === "text" && typeof content.text === "string") {
    return [{ type: "text", text: content.text }];
  }
  if (
    content.type === "image" &&
    typeof content.data === "string" &&
    typeof content.mimeType === "string" &&
    isImageMediaType(content.mimeType)
  ) {
    return [{
      type: "image",
      source: { type: "base64", mediaType: content.mimeType, data: content.data },
    }];
  }
  if (content.type === "resource" && isObject(content.resource)) {
    return resourceContentToBlocks(parseEmbeddedResource(content.resource));
  }
  if (content.type === "resource_link" && typeof content.uri === "string") {
    return [{ type: "text", text: `MCP resource: ${content.uri}` }];
  }
  throw new Error(`Unsupported MCP prompt content type: ${String(content.type)}`);
}

function parseEmbeddedResource(resource: Record<string, unknown>): McpResourceContent {
  if (typeof resource.uri !== "string" || !resource.uri) {
    throw new Error("MCP embedded resource URI is required");
  }
  if (resource.mimeType !== undefined && typeof resource.mimeType !== "string") {
    throw new Error("MCP embedded resource MIME type must be a string");
  }
  const hasText = typeof resource.text === "string";
  const hasBlob = typeof resource.blob === "string";
  if (hasText === hasBlob) {
    throw new Error("MCP embedded resource must contain exactly one of text or blob");
  }
  return {
    uri: resource.uri,
    ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
    ...(hasText ? { text: resource.text as string } : { blob: resource.blob as string }),
  };
}

function resourceContentToBlocks(resource: McpResourceContent): Array<TextBlock | MediaBlock> {
  if (resource.text !== undefined) return [{ type: "text", text: resource.text }];
  if (!resource.blob || !resource.mimeType) {
    throw new Error(`MCP binary resource ${resource.uri} must declare a MIME type`);
  }
  if (isImageMediaType(resource.mimeType)) {
    return [{
      type: "image",
      source: { type: "base64", mediaType: resource.mimeType, data: resource.blob },
    }];
  }
  if (resource.mimeType === "application/pdf") {
    return [{
      type: "document",
      source: { type: "base64", mediaType: "application/pdf", data: resource.blob },
      filename: resourceFilename(resource.uri),
    }];
  }
  throw new Error(`Unsupported MCP embedded resource MIME type: ${resource.mimeType}`);
}

function isImageMediaType(
  value: string,
): value is "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  return value === "image/jpeg" || value === "image/png" || value === "image/gif" || value === "image/webp";
}

function resourceFilename(uri: string): string {
  try {
    const name = basename(new URL(uri).pathname);
    if (name) return name;
  } catch {
    const name = basename(uri);
    if (name) return name;
  }
  return "resource.pdf";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
