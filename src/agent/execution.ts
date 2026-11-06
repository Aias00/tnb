import type { AgentLoopOptions } from "../core/agent-loop";
import type { BillingRoute } from "../services/usage/budget";
import { validateDomainDescriptor, type DomainDescriptor } from "./domain";
import { integer, text } from "../services/runtime/json";
import type { ExecutionPolicy } from "../services/runtime/types";

/** Domain-neutral persisted limits. Business inputs belong to descriptor.config. */
export type ExecutionConfiguration = {
  maxTurns: number; maxRetries: number; compactThreshold: number;
  maxModelRequests?: number; maxCostUsd?: number; provider?: string; model?: string;
};
export type AgentTaskInput = Partial<ExecutionConfiguration> & {
  commandId: string; objective: string; namespace: string; adapter: DomainDescriptor;
  mode?: ExecutionPolicy["mode"]; deadline?: number; originSessionId?: string;
};

export function agentNamespace(namespace: string): string { return `agent:${text(namespace, "task namespace", 256)}`; }

/** Validate the JSON entry contract before opening an owner or mutating task state. */
export function validateAgentTaskInput(value: unknown): AgentTaskInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Expected an Agent task object");
  const input = value as AgentTaskInput;
  if (Object.keys(input).some(key => !["commandId", "objective", "namespace", "adapter", "mode", "deadline", "originSessionId", "maxTurns", "maxRetries", "compactThreshold", "maxModelRequests", "maxCostUsd", "provider", "model"].includes(key))) throw new Error("Unknown Agent task field");
  text(input.commandId, "command ID", 128); text(input.objective, "run objective"); agentNamespace(input.namespace);
  if (input.mode !== undefined && !["single", "auto", "multi"].includes(input.mode)) throw new Error("Invalid execution mode");
  for (const [key, min, max] of [["maxTurns", 1, 2000], ["maxRetries", 0, 10], ["compactThreshold", 1000, Number.MAX_SAFE_INTEGER], ["maxModelRequests", 4, 10000], ["deadline", 1, Number.MAX_SAFE_INTEGER]] as const) {
    if (input[key] !== undefined) integer(input[key]!, key, min, max);
  }
  if (input.maxCostUsd !== undefined && (!Number.isFinite(input.maxCostUsd) || input.maxCostUsd <= 0)) throw new Error("Budget must be positive");
  for (const key of ["provider", "model", "originSessionId"] as const) if (input[key] !== undefined) text(input[key]!, key, key === "originSessionId" ? 128 : 256);
  return { ...structuredClone(input), adapter: validateDomainDescriptor(input.adapter) };
}
export type WorkerResources = Pick<AgentLoopOptions, "transport" | "model" | "tools" | "authorize"> & {
  route: BillingRoute; maxOutputTokens: number; contextWindowTokens?: number;
  projectInstructions?: string; systemInstructions?: string; binding?: unknown;
  check?(command: string, signal: AbortSignal): Promise<string>;
  close?(): Promise<void>;
};

/** Whitelist public execution data; never spread host configuration into a plugin context. */
export function executionConfiguration(value: ExecutionConfiguration): ExecutionConfiguration {
  return { maxTurns: value.maxTurns, maxRetries: value.maxRetries, compactThreshold: value.compactThreshold,
    ...(value.maxModelRequests !== undefined ? { maxModelRequests: value.maxModelRequests } : {}),
    ...(value.maxCostUsd !== undefined ? { maxCostUsd: value.maxCostUsd } : {}),
    ...(value.provider !== undefined ? { provider: value.provider } : {}), ...(value.model !== undefined ? { model: value.model } : {}) };
}
