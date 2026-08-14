import { createAnthropicTransport } from "./anthropic";
import { createFallbackTransport } from "./fallback";
import { createOpenAITransport } from "./openai";
import { createOpenAIResponsesTransport } from "./openai-responses";
import type { ProviderSelection } from "./config";
import type { ModelTransport } from "./types";

export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export function createConfiguredTransport(
  selection: ProviderSelection,
  reasoningEffort?: ReasoningEffort,
  fastMode = false,
): ModelTransport {
  const { provider, model } = selection;
  if (fastMode && (provider.api !== "anthropic-messages" || !isAnthropicFastModeModel(model.id))) {
    throw new Error("Fast mode currently requires an Anthropic Opus 4.6 model");
  }
  if (provider.api === "openai-completions" || provider.api === "openai-responses") {
    if (!provider.apiKey && provider.id === "openai") throw new Error("OPENAI_API_KEY is required");
    const options = {
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      baseUrl: provider.baseUrl,
      headers: { ...provider.headers, ...model.headers },
      maxOutputTokens: model.maxTokens,
      compat: model.compat,
      reasoning: model.reasoning,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      samplingParams: model.samplingParams,
    };
    return provider.api === "openai-responses"
      ? createOpenAIResponsesTransport(options)
      : createOpenAITransport(options);
  }
  if (!provider.apiKey && provider.id === "anthropic") throw new Error("ANTHROPIC_API_KEY is required");
  const transport = createAnthropicTransport({
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    baseUrl: provider.baseUrl,
    headers: { ...provider.headers, ...model.headers },
    maxOutputTokens: model.maxTokens,
    ...(provider.promptCaching ? { promptCaching: provider.promptCaching } : {}),
    ...(model.compat.anthropicRequiredToolChoice
      ? { requiredToolChoice: model.compat.anthropicRequiredToolChoice }
      : {}),
  });
  if (!fastMode) return transport;
  return withFastMode(transport);
}

export function createConfiguredTransportWithFallback(
  primarySelection: ProviderSelection,
  fallbackSelection: ProviderSelection | undefined,
  reasoningEffort?: ReasoningEffort,
  onFallback?: () => void,
  fastMode = false,
): ModelTransport {
  const primary = createConfiguredTransport(primarySelection, reasoningEffort, fastMode);
  if (!fallbackSelection) return primary;
  if (
    fallbackSelection.provider.id === primarySelection.provider.id &&
    fallbackSelection.model.id === primarySelection.model.id
  ) {
    throw new Error("--fallback-model must differ from the primary model");
  }
  return createFallbackTransport({
    primary,
    fallback: createConfiguredTransport(fallbackSelection, reasoningEffort),
    fallbackModel: fallbackSelection.model.id,
    ...(onFallback ? { onFallback } : {}),
  });
}

function withFastMode(transport: ModelTransport): ModelTransport {
  return {
    stream(request, signal) {
      return transport.stream({ ...request, speed: "fast" }, signal);
    },
  };
}

function isAnthropicFastModeModel(model: string): boolean {
  return model.toLowerCase().replace(/\[1m\]$/, "").includes("opus-4-6");
}
