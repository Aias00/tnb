import type { AgentLoopOptions } from "../core/agent-loop";
import type { BillingRoute } from "../services/usage/budget";
import type { DomainDescriptor } from "./domain";
import type { ExecutionPolicy } from "../services/runtime/types";

/** Domain-neutral persisted limits. Business inputs belong to descriptor.config. */
export type ExecutionConfiguration = {
  maxTurns: number; maxRetries: number; compactThreshold: number;
  maxModelRequests?: number; maxCostUsd?: number; provider?: string; model?: string;
};
export type AgentTaskInput = Partial<ExecutionConfiguration> & {
  commandId: string; objective: string; namespace: string; adapter: DomainDescriptor;
  mode?: ExecutionPolicy["mode"]; deadline?: number;
};
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
