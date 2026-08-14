import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PermissionMode } from "../../core/permissions";
import {
  frontmatterStringList,
  parseFrontmatterFields,
  requiredFrontmatterString,
} from "../skills/loader";

export type AgentSource = "user" | "claude-project" | "project" | "plugin" | "cli";

export type LoadedAgent = {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  source: AgentSource;
  filePath: string;
  baseDir: string;
};

export type AgentLoadResult = {
  agents: LoadedAgent[];
  errors: Array<{ path: string; error: string }>;
};

export function parseAgentMarkdown(
  markdown: string,
  path: string,
): Omit<LoadedAgent, "source" | "filePath" | "baseDir"> {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) throw new Error(`Agent frontmatter is required: ${path}`);
  const fields = parseFrontmatterFields(match[1] ?? "", path);
  const name = requiredFrontmatterString(fields.name, "name", path);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error(`Invalid agent name: ${name}`);
  }
  const description = requiredFrontmatterString(fields.description, "description", path);
  const prompt = markdown.slice(match[0].length).trim();
  if (!prompt) throw new Error(`Agent prompt is required: ${path}`);
  const tools = frontmatterStringList(fields.tools, "tools", path);
  const disallowedTools = frontmatterStringList(
    fields.disallowedTools ?? fields["disallowed-tools"],
    "disallowedTools",
    path,
  );
  const model = optionalString(fields.model, "model", path);
  const permissionMode = parsePermissionMode(
    fields.permissionMode ?? fields["permission-mode"],
    path,
  );
  const maxTurns = parsePositiveInteger(
    fields.maxTurns ?? fields["max-turns"],
    "maxTurns",
    path,
  );
  return {
    name,
    description,
    prompt,
    ...(tools ? { tools } : {}),
    ...(disallowedTools ? { disallowedTools } : {}),
    ...(model ? { model } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(maxTurns ? { maxTurns } : {}),
  };
}

export async function loadAgents(
  sources: Array<{ directory: string; source: AgentSource }>,
): Promise<AgentLoadResult> {
  const loaded = new Map<string, LoadedAgent>();
  const errors: AgentLoadResult["errors"] = [];
  for (const source of sources) {
    let entries;
    try {
      entries = await readdir(source.directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const filePath = join(source.directory, entry.name);
      try {
        const agent = parseAgentMarkdown(await readFile(filePath, "utf8"), filePath);
        loaded.set(agent.name.toLowerCase(), {
          ...agent,
          source: source.source,
          filePath,
          baseDir: dirname(filePath),
        });
      } catch (error) {
        errors.push({
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { agents: [...loaded.values()], errors };
}

export function parseAgentsJson(json: string, cwd: string = process.cwd()): LoadedAgent[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error("Invalid agents JSON: --agents", { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("--agents must be a JSON object keyed by agent name");
  }
  return Object.entries(value).map(([name, definition]) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error(`Invalid agent name: ${name}`);
    if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
      throw new Error(`Agent ${name} definition must be an object`);
    }
    const fields = definition as Record<string, unknown>;
    const description = jsonString(fields.description, `${name}.description`);
    const prompt = jsonString(fields.prompt, `${name}.prompt`);
    const tools = jsonStringArray(fields.tools, `${name}.tools`);
    const disallowedTools = jsonStringArray(fields.disallowedTools ?? fields["disallowed-tools"], `${name}.disallowedTools`);
    const model = fields.model === undefined ? undefined : jsonString(fields.model, `${name}.model`);
    const permissionMode = fields.permissionMode === undefined && fields["permission-mode"] === undefined
      ? undefined
      : parseJsonPermissionMode(fields.permissionMode ?? fields["permission-mode"], name);
    const maxTurns = fields.maxTurns ?? fields["max-turns"];
    if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || (maxTurns as number) < 1)) {
      throw new Error(`Agent ${name}.maxTurns must be a positive integer`);
    }
    return {
      name,
      description,
      prompt,
      ...(tools ? { tools } : {}),
      ...(disallowedTools ? { disallowedTools } : {}),
      ...(model ? { model } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(typeof maxTurns === "number" ? { maxTurns } : {}),
      source: "cli" as const,
      filePath: "--agents",
      baseDir: cwd,
    };
  });
}

function jsonString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Agent ${field} must be a non-empty string`);
  return value.trim();
}

function jsonStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Agent ${field} must be an array of non-empty strings`);
  }
  return value.map((item) => (item as string).trim());
}

function parseJsonPermissionMode(value: unknown, name: string): PermissionMode {
  if (
    value === "default" || value === "acceptEdits" || value === "auto" ||
    value === "bypassPermissions" || value === "dontAsk" || value === "plan"
  ) return value;
  throw new Error(`Invalid agent permissionMode for ${name}`);
}

function optionalString(
  value: string | string[] | undefined,
  field: string,
  path: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Agent ${field} must be a non-empty string: ${path}`);
  }
  return value.trim();
}

function parsePermissionMode(
  value: string | string[] | undefined,
  path: string,
): PermissionMode | undefined {
  const mode = optionalString(value, "permissionMode", path);
  if (mode === undefined) return undefined;
  if (
    mode === "default" ||
    mode === "acceptEdits" ||
    mode === "auto" ||
    mode === "bypassPermissions" ||
    mode === "dontAsk" ||
    mode === "plan"
  ) {
    return mode;
  }
  throw new Error(`Invalid agent permissionMode '${mode}': ${path}`);
}

function parsePositiveInteger(
  value: string | string[] | undefined,
  field: string,
  path: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`Agent ${field} must be a positive integer: ${path}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Agent ${field} must be a positive integer: ${path}`);
  }
  return parsed;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}
