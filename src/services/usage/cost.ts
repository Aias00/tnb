import type { TokenUsage } from "../../providers/types";

export type ModelPricing = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type UsageTotals = TokenUsage & { costUsd: number };

export const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUsd: 0,
};

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    ...((left.costUsd !== undefined || right.costUsd !== undefined)
      ? { costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0) }
      : {}),
  };
}

export function calculateCostUsd(usage: TokenUsage, pricing?: ModelPricing): number {
  if (!pricing) return 0;
  return (
    usage.inputTokens * pricing.input +
    usage.outputTokens * pricing.output +
    usage.cacheReadInputTokens * (pricing.cacheRead ?? pricing.input) +
    usage.cacheCreationInputTokens * (pricing.cacheWrite ?? pricing.input)
  ) / 1_000_000;
}

export function withCost(usage: TokenUsage, pricing?: ModelPricing): UsageTotals {
  return { ...usage, costUsd: calculateCostUsd(usage, pricing) };
}
