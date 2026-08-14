import type { JsonRpcId } from "./client";

export type McpProgressEvent = {
  serverName: string;
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
};

export type McpCancelledEvent = {
  serverName: string;
  requestId?: JsonRpcId;
  reason?: string;
};

export function parseMcpProgressEvent(
  serverName: string,
  params: unknown,
): McpProgressEvent | undefined {
  if (!isRecord(params)) return undefined;
  if (!isRpcId(params.progressToken) || !isFiniteNumber(params.progress)) return undefined;
  if (params.total !== undefined && !isFiniteNumber(params.total)) return undefined;
  if (params.message !== undefined && typeof params.message !== "string") return undefined;
  return {
    serverName,
    progressToken: params.progressToken,
    progress: params.progress,
    ...(params.total === undefined ? {} : { total: params.total as number }),
    ...(params.message === undefined ? {} : { message: params.message as string }),
  };
}

export function parseMcpCancelledEvent(
  serverName: string,
  params: unknown,
): McpCancelledEvent | undefined {
  if (!isRecord(params)) return undefined;
  if (params.requestId !== undefined && !isRpcId(params.requestId)) return undefined;
  if (params.reason !== undefined && typeof params.reason !== "string") return undefined;
  return {
    serverName,
    ...(params.requestId === undefined ? {} : { requestId: params.requestId }),
    ...(params.reason === undefined ? {} : { reason: params.reason as string }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
