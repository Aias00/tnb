export const MCP_LOG_LEVELS = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
] as const;

export type McpLogLevel = typeof MCP_LOG_LEVELS[number];

export type McpLogMessage = {
  serverName: string;
  level: McpLogLevel;
  logger?: string;
  data: unknown;
};

export function isMcpLogLevel(value: unknown): value is McpLogLevel {
  return typeof value === "string" && (MCP_LOG_LEVELS as readonly string[]).includes(value);
}

export function meetsMcpLogLevel(level: McpLogLevel, minimum: McpLogLevel): boolean {
  return MCP_LOG_LEVELS.indexOf(level) >= MCP_LOG_LEVELS.indexOf(minimum);
}

export function parseMcpLogMessage(serverName: string, params: unknown): McpLogMessage | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  const value = params as Record<string, unknown>;
  if (!isMcpLogLevel(value.level) || !("data" in value)) return undefined;
  if (value.logger !== undefined && typeof value.logger !== "string") return undefined;
  return {
    serverName,
    level: value.level,
    ...(value.logger === undefined ? {} : { logger: value.logger as string }),
    data: value.data,
  };
}
