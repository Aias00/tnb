import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { AgentTool } from "../../core/tool";
import type { MediaBlock } from "../../core/message";
import type {
  McpResourceContent,
  McpResourceDefinition,
  McpResourceTemplate,
  McpToolDefinition,
  McpToolResult,
} from "./client";

export function createMcpTools(
  _serverName: string,
  client: {
    callTool(name: string, input: unknown, signal?: AbortSignal): Promise<McpToolResult>;
  },
  definitions: McpToolDefinition[],
): AgentTool[] {
  const names = new Set<string>();
  return definitions.map((definition) => {
    const name = buildMcpToolName(_serverName, definition.name);
    if (names.has(name)) throw new Error(`MCP tool name collision: ${name}`);
    names.add(name);
    return {
      name,
      description: definition.description ?? "",
      inputSchema: definition.inputSchema,
      validate(input) {
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
          throw new Error(`${name} input must be an object`);
        }
        return input;
      },
      async execute(input, signal) {
        const result = await client.callTool(definition.name, input, signal);
        const output = formatMcpResult(result);
        if (result.isError) throw new Error(output || "MCP tool returned an error");
        return output;
      },
      access: "unknown",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
    } satisfies AgentTool;
  });
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  const fullName = `mcp__${normalizeName(serverName)}__${normalizeName(toolName)}`;
  if (fullName.length <= 64) return fullName;
  const hash = createHash("sha256").update(fullName).digest("hex").slice(0, 10);
  return `${fullName.slice(0, 53)}_${hash}`;
}

export function createMcpResourceTool(
  serverName: string,
  client: {
    readResource(uri: string, signal?: AbortSignal): Promise<McpResourceContent[]>;
    subscribeResource?(uri: string, signal?: AbortSignal): Promise<void>;
  },
  definitions: McpResourceDefinition[],
  options?: {
    templates?: McpResourceTemplate[];
    canSubscribe?: boolean;
  },
): AgentTool {
  const name = buildMcpToolName(serverName, "read_resource");
  const templates = options?.templates ?? [];
  const available = definitions.length === 0
    ? "The server did not advertise fixed resource URIs; use a URI supported by the server."
    : `Available resources:\n${definitions.map(formatResourceDefinition).join("\n")}`;
  const templateDescription = templates.length > 0
    ? `\nAvailable URI templates:\n${templates.map(formatResourceTemplate).join("\n")}`
    : "";
  return {
    name,
    description: `Read a resource exposed by the ${serverName} MCP server. ${available}${templateDescription}`,
    inputSchema: {
      type: "object",
      properties: {
        uri: {
          type: "string",
          description: "Exact resource URI to read",
          ...(definitions.length > 0 && templates.length === 0
            ? { enum: definitions.map((resource) => resource.uri) }
            : {}),
        },
        ...(options?.canSubscribe
          ? {
              subscribe: {
                type: "boolean",
                description: "Subscribe to update notifications for this URI before reading it",
              },
            }
          : {}),
      },
      required: ["uri"],
      additionalProperties: false,
    },
    validate(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error(`${name} input must be an object`);
      }
      const uri = (input as { uri?: unknown }).uri;
      if (typeof uri !== "string" || !uri) throw new Error(`${name} uri must be a non-empty string`);
      const subscribe = (input as { subscribe?: unknown }).subscribe;
      if (subscribe !== undefined && typeof subscribe !== "boolean") {
        throw new Error(`${name} subscribe must be a boolean`);
      }
      return { uri, ...(subscribe === true ? { subscribe: true } : {}) };
    },
    async execute(input, signal) {
      const request = input as { uri: string; subscribe?: boolean };
      if (request.subscribe) await client.subscribeResource?.(request.uri, signal);
      const contents = await client.readResource(request.uri, signal);
      return formatMcpResourceContents(contents);
    },
    access: "unknown",
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
  };
}

export function createMcpResourceUpdatesTool(
  serverName: string,
  updatedUris: Set<string>,
): AgentTool {
  const name = buildMcpToolName(serverName, "resource_updates");
  return {
    name,
    description: `List resource URIs updated by the ${serverName} MCP server after this session subscribed to them.`,
    inputSchema: {
      type: "object",
      properties: {
        clear: {
          type: "boolean",
          description: "Remove the returned update markers after listing them",
        },
      },
      additionalProperties: false,
    },
    validate(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error(`${name} input must be an object`);
      }
      const clear = (input as { clear?: unknown }).clear;
      if (clear !== undefined && typeof clear !== "boolean") {
        throw new Error(`${name} clear must be a boolean`);
      }
      return { clear: clear === true };
    },
    async execute(input) {
      const uris = [...updatedUris].sort();
      if ((input as { clear: boolean }).clear) updatedUris.clear();
      return JSON.stringify({ updatedResources: uris });
    },
    access: "unknown",
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
  };
}

function normalizeName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!normalized) throw new Error("MCP server and tool names must contain an alphanumeric character");
  return normalized;
}

function formatMcpResult(result: McpToolResult): string {
  const parts = result.content.map((item) => {
    if (
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      return (item as { text: string }).text;
    }
    return JSON.stringify(item);
  });
  if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts.filter(Boolean).join("\n");
}

function formatResourceDefinition(resource: McpResourceDefinition): string {
  const details = [resource.name, resource.mimeType, resource.description].filter(Boolean).join(" — ");
  return `- ${resource.uri}${details ? ` (${details})` : ""}`;
}

function formatResourceTemplate(template: McpResourceTemplate): string {
  const details = [template.title ?? template.name, template.mimeType, template.description]
    .filter(Boolean)
    .join(" — ");
  return `- ${template.uriTemplate}${details ? ` (${details})` : ""}`;
}

function formatMcpResourceContents(contents: McpResourceContent[]): string | {
  content: string;
  attachments: MediaBlock[];
} {
  const text: string[] = [];
  const attachments: MediaBlock[] = [];
  for (const item of contents) {
    if (item.text !== undefined) {
      text.push(contents.length === 1 ? item.text : `${item.uri}\n${item.text}`);
      continue;
    }
    const mediaType = item.mimeType;
    if (!item.blob || !mediaType) {
      throw new Error(`MCP binary resource ${item.uri} must declare a MIME type`);
    }
    if (isImageMediaType(mediaType)) {
      attachments.push({
        type: "image",
        source: { type: "base64", mediaType, data: item.blob },
      });
      text.push(`Image resource: ${item.uri}`);
      continue;
    }
    if (mediaType === "application/pdf") {
      attachments.push({
        type: "document",
        source: { type: "base64", mediaType, data: item.blob },
        filename: resourceFilename(item.uri),
      });
      text.push(`PDF resource: ${item.uri}`);
      continue;
    }
    throw new Error(`Unsupported MCP binary resource MIME type: ${mediaType}`);
  }
  const content = text.join("\n\n");
  return attachments.length > 0 ? { content, attachments } : content;
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
