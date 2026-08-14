import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getModelCapabilities } from "./models";
import type { ModelPricing } from "../services/usage/cost";

export type ProviderApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export type OpenAICompatibility = {
  profile?: "generic" | "glm" | "qwen" | "deepseek" | "openrouter";
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  supportsUsageInStreaming?: boolean;
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?: "openai" | "deepseek" | "qwen" | "openrouter";
  anthropicRequiredToolChoice?: "any" | "auto";
};

export type ProviderModel = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  supportsVision: boolean;
  supportsPdf: boolean;
  compat: OpenAICompatibility;
  samplingParams: Record<string, unknown>;
  headers?: Record<string, string>;
  pricing?: ModelPricing;
};

export type ProviderDefinition = {
  id: string;
  name: string;
  api: ProviderApi;
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string>;
  models: ProviderModel[];
  compat: OpenAICompatibility;
  promptCaching?: false | "5m" | "1h";
};

export type ProviderCatalog = {
  providers: Record<string, ProviderDefinition>;
};

export type ProviderSelection = {
  provider: ProviderDefinition;
  model: ProviderModel;
};

export async function loadProviderCatalog(options: {
  configDir: string;
  env: Record<string, string | undefined>;
}): Promise<ProviderCatalog> {
  const path = join(options.configDir, "models.json");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { providers: builtInProviders(options.env) };
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid models JSON: ${path}`, { cause: error });
  }
  const root = requireObject(value, `Models configuration must be an object: ${path}`);
  const configuredProviders = requireObject(
    root.providers,
    `models.providers must be an object: ${path}`,
  );
  const providers: Record<string, ProviderDefinition> = builtInProviders(options.env);
  for (const [id, configured] of Object.entries(configuredProviders)) {
    providers[id] = parseProvider(id, configured, options.env, path, providers[id]);
  }
  return { providers };
}

function builtInProviders(
  env: Record<string, string | undefined>,
): Record<string, ProviderDefinition> {
  const anthropicCapabilities = getModelCapabilities("claude-sonnet-4-6", "anthropic");
  const openAICapabilities = getModelCapabilities("gpt-4o", "openai");
  return {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      api: "anthropic-messages",
      baseUrl: normalizeBaseUrl(
        env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
        "anthropic",
      ),
      ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
      headers: {},
      models: [
        {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          contextWindow: anthropicCapabilities.contextWindowTokens,
          maxTokens: anthropicCapabilities.maxOutputTokens,
          reasoning: true,
          supportsVision: true,
          supportsPdf: true,
          compat: {},
          samplingParams: {},
          pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        },
      ],
      compat: {},
      promptCaching: "5m",
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      api: "openai-completions",
      baseUrl: normalizeBaseUrl(
        env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        "openai",
      ),
      ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}),
      headers: {},
      models: [
        {
          id: "gpt-4o",
          name: "GPT-4o",
          contextWindow: openAICapabilities.contextWindowTokens,
          maxTokens: openAICapabilities.maxOutputTokens,
          reasoning: false,
          supportsVision: true,
          supportsPdf: true,
          compat: { supportsUsageInStreaming: true },
          samplingParams: {},
          pricing: { input: 2.5, output: 10, cacheRead: 1.25 },
        },
      ],
      compat: { supportsUsageInStreaming: true },
    },
  };
}

export function resolveProviderSelection(
  catalog: ProviderCatalog,
  providerId: string,
  modelId?: string,
): ProviderSelection {
  const provider = catalog.providers[providerId];
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  let model = modelId
    ? provider.models.find((candidate) => candidate.id === modelId)
    : provider.models[0];
  if (!model && modelId && (providerId === "anthropic" || providerId === "openai")) {
    const capabilities = getModelCapabilities(modelId, providerId);
    model = {
      id: modelId,
      name: modelId,
      contextWindow: capabilities.contextWindowTokens,
      maxTokens: capabilities.maxOutputTokens,
      reasoning: providerId === "anthropic",
      supportsVision: true,
      supportsPdf: true,
      compat: { ...provider.compat },
      samplingParams: {},
      ...pricingField(providerId, modelId),
    };
  }
  if (!model) {
    throw new Error(
      modelId
        ? `Unknown model for provider ${providerId}: ${modelId}`
        : `Provider ${providerId} has no models`,
    );
  }
  return { provider, model };
}

function parseProvider(
  id: string,
  value: unknown,
  env: Record<string, string | undefined>,
  path: string,
  base?: ProviderDefinition,
): ProviderDefinition {
  if (!id) throw new Error(`Provider ids must not be empty: ${path}`);
  const provider = requireObject(value, `Provider ${id} must be an object: ${path}`);
  const api = provider.api ?? base?.api;
  if (
    api !== "anthropic-messages" &&
    api !== "openai-completions" &&
    api !== "openai-responses"
  ) {
    throw new Error(
      `Provider ${id}.api must be anthropic-messages, openai-completions, or openai-responses`,
    );
  }
  const baseUrl = normalizeBaseUrl(
    provider.baseUrl === undefined
      ? nonEmptyString(base?.baseUrl, `Provider ${id}.baseUrl is required`)
      : nonEmptyString(provider.baseUrl, `Provider ${id}.baseUrl is required`),
    id,
  );
  if (provider.models !== undefined && (!Array.isArray(provider.models) || provider.models.length === 0)) {
    throw new Error(`Provider ${id}.models must contain at least one model`);
  }
  if (provider.models === undefined && !base) {
    throw new Error(`Provider ${id}.models must contain at least one model`);
  }
  const headers = {
    ...base?.headers,
    ...parseHeaders(provider.headers, env, `Provider ${id}.headers`),
  };
  const compat = {
    ...base?.compat,
    ...parseCompatibility(provider.compat, `Provider ${id}.compat`),
  };
  const promptCaching = parsePromptCaching(provider.promptCaching, base?.promptCaching, `Provider ${id}.promptCaching`);
  let models = provider.models === undefined
    ? base!.models.map((model) => ({
        ...model,
        compat: { ...model.compat, ...compat },
        samplingParams: { ...model.samplingParams },
        ...(model.headers ? { headers: { ...model.headers } } : {}),
      }))
    : provider.models.map((model, index) =>
        parseModel(model, id, index, compat, env),
      );
  models = applyModelOverrides(models, provider.modelOverrides, id, env);
  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.id)) throw new Error(`Provider ${id} has duplicate model id: ${model.id}`);
    modelIds.add(model.id);
  }
  return {
    id,
    name: optionalString(provider.name, base?.name ?? id, `Provider ${id}.name`),
    api,
    baseUrl,
    ...(provider.apiKey !== undefined
      ? { apiKey: resolveConfigValue(nonEmptyString(provider.apiKey, `Provider ${id}.apiKey`), env) }
      : base?.apiKey
        ? { apiKey: base.apiKey }
        : {}),
    headers,
    models,
    compat,
    ...(promptCaching === undefined ? {} : { promptCaching }),
  };
}

function parseModel(
  value: unknown,
  providerId: string,
  index: number,
  providerCompat: OpenAICompatibility,
  env: Record<string, string | undefined>,
): ProviderModel {
  const model = requireObject(value, `Provider ${providerId}.models[${index}] must be an object`);
  const id = nonEmptyString(model.id, `Provider ${providerId}.models[${index}].id is required`);
  return {
    id,
    name: optionalString(model.name, id, `Model ${providerId}/${id}.name`),
    contextWindow: positiveNumber(model.contextWindow, 128_000, `Model ${providerId}/${id}.contextWindow`),
    maxTokens: positiveNumber(model.maxTokens, 16_384, `Model ${providerId}/${id}.maxTokens`),
    reasoning: optionalBoolean(model.reasoning, false, `Model ${providerId}/${id}.reasoning`),
    supportsVision: optionalBoolean(
      model.supportsVision,
      false,
      `Model ${providerId}/${id}.supportsVision`,
    ),
    supportsPdf: optionalBoolean(
      model.supportsPdf,
      false,
      `Model ${providerId}/${id}.supportsPdf`,
    ),
    compat: {
      ...providerCompat,
      ...parseCompatibility(model.compat, `Model ${providerId}/${id}.compat`),
    },
    samplingParams: model.samplingParams === undefined
      ? {}
      : requireObject(model.samplingParams, `Model ${providerId}/${id}.samplingParams must be an object`),
    ...(model.pricing === undefined ? {} : { pricing: parsePricing(model.pricing, `Model ${providerId}/${id}.pricing`) }),
    ...(model.headers === undefined
      ? {}
      : { headers: parseHeaders(model.headers, env, `Model ${providerId}/${id}.headers`) }),
  };
}

function applyModelOverrides(
  models: ProviderModel[],
  value: unknown,
  providerId: string,
  env: Record<string, string | undefined>,
): ProviderModel[] {
  if (value === undefined) return models;
  const overrides = requireObject(value, `Provider ${providerId}.modelOverrides must be an object`);
  const byId = new Map(models.map((model) => [model.id, model]));
  for (const [modelId, rawOverride] of Object.entries(overrides)) {
    const model = byId.get(modelId);
    if (!model) throw new Error(`Provider ${providerId}.modelOverrides references unknown model: ${modelId}`);
    const override = requireObject(
      rawOverride,
      `Provider ${providerId}.modelOverrides.${modelId} must be an object`,
    );
    byId.set(modelId, {
      ...model,
      name: optionalString(override.name, model.name, `Model ${providerId}/${modelId}.name`),
      contextWindow: positiveNumber(
        override.contextWindow,
        model.contextWindow,
        `Model ${providerId}/${modelId}.contextWindow`,
      ),
      maxTokens: positiveNumber(
        override.maxTokens,
        model.maxTokens,
        `Model ${providerId}/${modelId}.maxTokens`,
      ),
      reasoning: optionalBoolean(
        override.reasoning,
        model.reasoning,
        `Model ${providerId}/${modelId}.reasoning`,
      ),
      supportsVision: optionalBoolean(
        override.supportsVision,
        model.supportsVision,
        `Model ${providerId}/${modelId}.supportsVision`,
      ),
      supportsPdf: optionalBoolean(
        override.supportsPdf,
        model.supportsPdf,
        `Model ${providerId}/${modelId}.supportsPdf`,
      ),
      compat: {
        ...model.compat,
        ...parseCompatibility(override.compat, `Model ${providerId}/${modelId}.compat`),
      },
      samplingParams: {
        ...model.samplingParams,
        ...(override.samplingParams === undefined
          ? {}
          : requireObject(
              override.samplingParams,
              `Model ${providerId}/${modelId}.samplingParams must be an object`,
            )),
      },
      ...(override.pricing === undefined
        ? model.pricing ? { pricing: model.pricing } : {}
        : { pricing: parsePricing(override.pricing, `Model ${providerId}/${modelId}.pricing`) }),
      ...(override.headers === undefined
        ? model.headers
          ? { headers: model.headers }
          : {}
        : {
            headers: {
              ...model.headers,
              ...parseHeaders(override.headers, env, `Model ${providerId}/${modelId}.headers`),
            },
          }),
    });
  }
  return models.map((model) => byId.get(model.id)!);
}

function parsePricing(value: unknown, field: string): ModelPricing {
  const pricing = requireObject(value, `${field} must be an object`);
  return {
    input: nonNegativeNumber(pricing.input, `${field}.input`),
    output: nonNegativeNumber(pricing.output, `${field}.output`),
    ...(pricing.cacheRead === undefined ? {} : { cacheRead: nonNegativeNumber(pricing.cacheRead, `${field}.cacheRead`) }),
    ...(pricing.cacheWrite === undefined ? {} : { cacheWrite: nonNegativeNumber(pricing.cacheWrite, `${field}.cacheWrite`) }),
  };
}

function parsePromptCaching(
  value: unknown,
  fallback: ProviderDefinition["promptCaching"],
  field: string,
): ProviderDefinition["promptCaching"] {
  if (value === undefined) return fallback;
  if (value === false || value === "5m" || value === "1h") return value;
  throw new Error(`${field} must be false, "5m", or "1h"`);
}

function builtInPricing(providerId: string, modelId: string): ModelPricing | undefined {
  if (providerId === "anthropic") {
    if (/sonnet/i.test(modelId)) return { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    if (/opus/i.test(modelId)) return { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
    if (/haiku/i.test(modelId)) return { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
  }
  if (providerId === "openai" && /^gpt-4o(?:-|$)/i.test(modelId)) {
    return { input: 2.5, output: 10, cacheRead: 1.25 };
  }
  return undefined;
}

function pricingField(providerId: string, modelId: string): { pricing?: ModelPricing } {
  const pricing = builtInPricing(providerId, modelId);
  return pricing ? { pricing } : {};
}

function parseHeaders(
  value: unknown,
  env: Record<string, string | undefined>,
  field: string,
): Record<string, string> {
  if (value === undefined) return {};
  const headers = requireObject(value, `${field} must be an object`);
  return Object.fromEntries(
    Object.entries(headers).map(([name, configured]) => [
      name,
      resolveConfigValue(nonEmptyString(configured, `${field}.${name}`), env),
    ]),
  );
}

function parseCompatibility(value: unknown, field: string): OpenAICompatibility {
  if (value === undefined) return {};
  const compat = requireObject(value, `${field} must be an object`);
  const profile = compat.profile;
  if (
    profile !== undefined &&
    profile !== "generic" &&
    profile !== "glm" &&
    profile !== "qwen" &&
    profile !== "deepseek" &&
    profile !== "openrouter"
  ) {
    throw new Error(`${field}.profile is invalid`);
  }
  const parsed: OpenAICompatibility = {
    ...(profile ? compatibilityProfile(profile) : {}),
    ...(profile ? { profile } : {}),
  };
  if (compat.maxTokensField !== undefined) {
    if (compat.maxTokensField !== "max_tokens" && compat.maxTokensField !== "max_completion_tokens") {
      throw new Error(`${field}.maxTokensField is invalid`);
    }
    parsed.maxTokensField = compat.maxTokensField;
  }
  for (const key of [
    "supportsDeveloperRole",
    "supportsReasoningEffort",
    "supportsUsageInStreaming",
    "requiresToolResultName",
    "requiresAssistantAfterToolResult",
    "requiresReasoningContentOnAssistantMessages",
  ] as const) {
    if (compat[key] !== undefined) {
      if (typeof compat[key] !== "boolean") throw new Error(`${field}.${key} must be boolean`);
      parsed[key] = compat[key];
    }
  }
  if (compat.thinkingFormat !== undefined) {
    if (
      compat.thinkingFormat !== "openai" &&
      compat.thinkingFormat !== "deepseek" &&
      compat.thinkingFormat !== "qwen" &&
      compat.thinkingFormat !== "openrouter"
    ) {
      throw new Error(`${field}.thinkingFormat is invalid`);
    }
    parsed.thinkingFormat = compat.thinkingFormat;
  }
  if (compat.anthropicRequiredToolChoice !== undefined) {
    if (compat.anthropicRequiredToolChoice !== "any" && compat.anthropicRequiredToolChoice !== "auto") {
      throw new Error(`${field}.anthropicRequiredToolChoice must be any or auto`);
    }
    parsed.anthropicRequiredToolChoice = compat.anthropicRequiredToolChoice;
  }
  return parsed;
}

export function compatibilityProfile(
  profile: NonNullable<OpenAICompatibility["profile"]>,
): OpenAICompatibility {
  switch (profile) {
    case "glm":
      return { maxTokensField: "max_tokens", supportsUsageInStreaming: true };
    case "qwen":
      return {
        maxTokensField: "max_tokens",
        supportsUsageInStreaming: true,
        thinkingFormat: "qwen",
        requiresReasoningContentOnAssistantMessages: true,
      };
    case "deepseek":
      return {
        maxTokensField: "max_tokens",
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        thinkingFormat: "deepseek",
        requiresReasoningContentOnAssistantMessages: true,
      };
    case "openrouter":
      return {
        maxTokensField: "max_tokens",
        supportsUsageInStreaming: true,
        thinkingFormat: "openrouter",
        requiresReasoningContentOnAssistantMessages: true,
      };
    case "generic":
      return {};
  }
}

function resolveConfigValue(value: string, env: Record<string, string | undefined>): string {
  const escapedDollar = "\u0000tnb-dollar\u0000";
  return value
    .replaceAll("$$", escapedDollar)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, plain) => {
      const name = (braced ?? plain) as string;
      const resolved = env[name];
      if (resolved === undefined) {
        throw new Error(`Environment variable ${name} is required by models.json`);
      }
      return resolved;
    })
    .replaceAll(escapedDollar, "$");
}

function normalizeBaseUrl(value: string, providerId: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Provider ${providerId}.baseUrl must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Provider ${providerId}.baseUrl must use http or https`);
  }
  return value.replace(/\/+$/, "");
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value;
}

function optionalString(value: unknown, defaultValue: string, field: string): string {
  return value === undefined ? defaultValue : nonEmptyString(value, `${field} must be a non-empty string`);
}

function positiveNumber(value: unknown, defaultValue: number, field: string): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return value;
}

function optionalBoolean(value: unknown, defaultValue: boolean, field: string): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
