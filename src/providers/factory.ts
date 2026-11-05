import { createAnthropicTransport } from "./anthropic";
import { createFallbackTransport } from "./fallback";
import { createOpenAITransport } from "./openai";
import { createOpenAIResponsesTransport } from "./openai-responses";
import { resolveProviderSelection, type ProviderSelection } from "./config";
import type { ModelTransport } from "./types";
import type { BillingRoute } from "../services/usage/budget";
import { createHash } from "node:crypto";

export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export function resolveBillingRoute(selection: ProviderSelection, modelId: string): BillingRoute {
  const { provider } = selection;
  const model = modelId === selection.model.id ? selection.model
    : provider.models.find((item) => item.id === modelId)
      ?? ((provider.id === "anthropic" || provider.id === "openai")
        ? resolveProviderSelection({ providers: { [provider.id]: provider } }, provider.id, modelId).model : undefined);
  return { provider: provider.id, model: modelId, ...(model?.pricing ? { pricing: model.pricing } : {}),
    resourceDomain: createHash("sha256").update(JSON.stringify({ api: provider.api, endpoint: provider.baseUrl?.replace(/\/+$/, ""), credential: provider.apiKey,
      headers: Object.fromEntries(Object.entries(provider.headers ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) })).digest("hex") };
}

export function createConfiguredTransport(
  selection: ProviderSelection,
  reasoningEffort?: ReasoningEffort,
  fastMode = false,
  execution?: { maxRetries?: number },
): ModelTransport {
  const transport = createRawConfiguredTransport(selection, reasoningEffort, fastMode, execution);
  return {
    async *stream(request, signal) {
      const billing = resolveBillingRoute(selection, request.model);
      for await (const event of transport.stream(request, signal)) {
        yield event.type === "usage" ? { ...event, billing } : event;
      }
    },
  };
}

function createRawConfiguredTransport(
  selection: ProviderSelection,
  reasoningEffort?: ReasoningEffort,
  fastMode = false,
  execution?: { maxRetries?: number },
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
      maxRetries: execution?.maxRetries,
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
    maxRetries: execution?.maxRetries,
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
