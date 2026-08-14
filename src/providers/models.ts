export const MODEL_DEFAULTS = {
  contextWindowTokens: 200_000,
  maxOutputTokens: 32_000,
  compactMaxOutputTokens: 20_000,
  autoCompactBufferTokens: 13_000,
} as const;

export type ModelCapabilities = {
  contextWindowTokens: number;
  maxOutputTokens: number;
};

export type ModelProvider = "anthropic" | "openai" | "openai-compatible";

const OPENAI_DEFAULT_CAPABILITIES: ModelCapabilities = {
  contextWindowTokens: 128_000,
  maxOutputTokens: 16_384,
};

const OPENAI_MODEL_CAPABILITIES: ReadonlyArray<{
  pattern: RegExp;
  capabilities: ModelCapabilities;
}> = [
  {
    pattern: /^gpt-4o(?:-\d{4}-\d{2}-\d{2})?$/,
    capabilities: { contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
  },
  {
    pattern: /^gpt-4\.1(?:-\d{4}-\d{2}-\d{2})?$/,
    capabilities: { contextWindowTokens: 1_047_576, maxOutputTokens: 32_768 },
  },
  {
    pattern: /^o3(?:-\d{4}-\d{2}-\d{2})?$/,
    capabilities: { contextWindowTokens: 200_000, maxOutputTokens: 100_000 },
  },
  {
    pattern: /^gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?$/,
    capabilities: { contextWindowTokens: 400_000, maxOutputTokens: 128_000 },
  },
];

export function usesOneMillionContext(model: string): boolean {
  return /\[1m\]$/i.test(model.trim());
}

export function getApiModelId(model: string): string {
  return usesOneMillionContext(model)
    ? model.trim().replace(/\[1m\]$/i, "").trim()
    : model;
}

export function getModelCapabilities(
  model: string,
  provider: ModelProvider = "anthropic",
): ModelCapabilities {
  if (provider !== "anthropic") {
    const normalizedModel = model.trim().toLowerCase();
    return OPENAI_MODEL_CAPABILITIES.find(({ pattern }) => pattern.test(normalizedModel))
      ?.capabilities ?? OPENAI_DEFAULT_CAPABILITIES;
  }
  return {
    contextWindowTokens: usesOneMillionContext(model)
      ? 1_000_000
      : MODEL_DEFAULTS.contextWindowTokens,
    maxOutputTokens: MODEL_DEFAULTS.maxOutputTokens,
  };
}

export function getAutoCompactThreshold(
  model: string,
  provider: ModelProvider = "anthropic",
): number {
  return getAutoCompactThresholdForCapabilities(getModelCapabilities(model, provider));
}

export function getAutoCompactThresholdForCapabilities(
  capabilities: ModelCapabilities,
): number {
  const effectiveContextWindow = capabilities.contextWindowTokens - Math.min(
    capabilities.maxOutputTokens,
    MODEL_DEFAULTS.compactMaxOutputTokens,
  );
  return effectiveContextWindow - MODEL_DEFAULTS.autoCompactBufferTokens;
}
