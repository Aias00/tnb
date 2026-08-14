import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isMcpLogLevel, type McpLogLevel } from "./logging";

export type McpStdioServerConfig = {
  type?: "stdio";
  protocol?: "legacy" | "auto" | "2026-07-28";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  logLevel?: McpLogLevel;
};

export type McpHttpServerConfig = {
  type: "http";
  protocol?: "legacy" | "auto" | "2026-07-28";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  logLevel?: McpLogLevel;
};

export type McpSseServerConfig = {
  type: "sse";
  protocol?: "legacy";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  logLevel?: McpLogLevel;
};

export type McpOAuthConfig = {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  authorizationServerUrl?: string;
  scopes?: string[];
};

export type McpServerConfig = (McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig) & {
  enabled?: boolean;
};

export type McpConfig = {
  mcpServers: Record<string, McpServerConfig>;
};

export async function loadMcpConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): Promise<McpConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return { mcpServers: {} };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid MCP config JSON: ${path}`, { cause: error });
  }
  return parseMcpConfig(value, env);
}

export async function loadMcpConfigInputs(
  inputs: readonly string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<McpConfig> {
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const input of inputs) {
    const trimmed = input.trim();
    const config = trimmed.startsWith("{")
      ? parseMcpConfigJson(trimmed, "--mcp-config", env)
      : await loadMcpConfig(resolve(cwd, input), env);
    Object.assign(mcpServers, config.mcpServers);
  }
  return { mcpServers };
}

export function mergeMcpConfigs(...configs: readonly McpConfig[]): McpConfig {
  return { mcpServers: Object.assign({}, ...configs.map((config) => config.mcpServers)) };
}

function parseMcpConfigJson(
  text: string,
  source: string,
  env: Record<string, string | undefined>,
): McpConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid MCP config JSON: ${source}`, { cause: error });
  }
  return parseMcpConfig(value, env);
}

function parseMcpConfig(
  value: unknown,
  env: Record<string, string | undefined>,
): McpConfig {
  if (!isObject(value) || !isObject(value.mcpServers)) {
    throw new Error("MCP config must contain an mcpServers object");
  }
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(value.mcpServers)) {
    const expanded = expandConfigValue(server, env);
    if (!isServerConfig(expanded)) throw new Error(`Invalid MCP server config: ${name}`);
    mcpServers[name] = expanded;
  }
  return { mcpServers };
}

export async function loadRawMcpConfig(path: string): Promise<McpConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissing(error)) return { mcpServers: {} };
    throw new Error(`Invalid MCP config JSON: ${path}`, { cause: error });
  }
  if (!isObject(value) || !isObject(value.mcpServers)) {
    throw new Error("MCP config must contain an mcpServers object");
  }
  return { mcpServers: value.mcpServers as Record<string, McpServerConfig> };
}

export async function updateMcpConfig(
  path: string,
  update: (servers: Record<string, McpServerConfig>) => void,
): Promise<McpConfig> {
  const config = await loadRawMcpConfig(path);
  update(config.mcpServers);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  return config;
}

export function validateMcpServerConfig(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): McpServerConfig {
  const expanded = expandConfigValue(value, env);
  if (!isServerConfig(expanded)) throw new Error("Invalid MCP server configuration");
  return value as McpServerConfig;
}

function expandConfigValue(
  value: unknown,
  env: Record<string, string | undefined>,
): unknown {
  if (typeof value === "string") return expand(value, env);
  if (Array.isArray(value)) return value.map((item) => expandConfigValue(item, env));
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, expandConfigValue(item, env)]),
  );
}

function expand(value: string, env: Record<string, string | undefined>): string {
  const escaped = "\u0000tnb-dollar\u0000";
  return value
    .replaceAll("$$", escaped)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, plain) => {
      const name = (braced ?? plain) as string;
      const resolved = env[name];
      if (resolved === undefined) throw new Error(`Environment variable ${name} is required by MCP config`);
      return resolved;
    })
    .replaceAll(escaped, "$");
}

function isServerConfig(value: unknown): value is McpServerConfig {
  if (!isObject(value)) return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  if (value.logLevel !== undefined && !isMcpLogLevel(value.logLevel)) return false;
  if (value.type === "http" || value.type === "sse") {
    if (typeof value.url !== "string" || !isHttpUrl(value.url)) return false;
    return (
      (value.protocol === undefined ||
        (value.type === "sse" ? value.protocol === "legacy" : isProtocolMode(value.protocol))) &&
      (value.headers === undefined || isStringRecord(value.headers)) &&
      (value.oauth === undefined || isOAuthConfig(value.oauth))
    );
  }
  if (value.type !== undefined && value.type !== "stdio") return false;
  if (value.protocol !== undefined && !isProtocolMode(value.protocol)) return false;
  if (typeof value.command !== "string" || !value.command) return false;
  if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every(isString))) {
    return false;
  }
  return value.env === undefined || isStringRecord(value.env);
}

function isProtocolMode(value: unknown): value is "legacy" | "auto" | "2026-07-28" {
  return value === "legacy" || value === "auto" || value === "2026-07-28";
}

function isOAuthConfig(value: unknown): value is McpOAuthConfig {
  if (!isObject(value)) return false;
  if (value.clientId !== undefined && typeof value.clientId !== "string") return false;
  if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") return false;
  if (
    value.callbackPort !== undefined &&
    (!Number.isInteger(value.callbackPort) || (value.callbackPort as number) < 1 || (value.callbackPort as number) > 65_535)
  ) return false;
  if (
    value.authorizationServerUrl !== undefined &&
    (typeof value.authorizationServerUrl !== "string" || !isHttpUrl(value.authorizationServerUrl))
  ) return false;
  return value.scopes === undefined || (Array.isArray(value.scopes) && value.scopes.every(isString));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every(isString);
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
