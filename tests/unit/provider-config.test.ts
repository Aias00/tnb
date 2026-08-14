import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compatibilityProfile,
  loadProviderCatalog,
  resolveProviderSelection,
} from "../../src/providers/config";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function configDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tnb-provider-config-"));
  directories.push(directory);
  return directory;
}

describe("provider configuration", () => {
  test("expands named GLM, Qwen, DeepSeek, and OpenRouter compatibility profiles", () => {
    expect(compatibilityProfile("glm")).toMatchObject({ maxTokensField: "max_tokens" });
    expect(compatibilityProfile("qwen")).toMatchObject({
      thinkingFormat: "qwen",
      requiresReasoningContentOnAssistantMessages: true,
    });
    expect(compatibilityProfile("deepseek")).toMatchObject({
      thinkingFormat: "deepseek",
      supportsReasoningEffort: true,
    });
    expect(compatibilityProfile("openrouter")).toMatchObject({
      thinkingFormat: "openrouter",
      supportsUsageInStreaming: true,
    });
  });

  test("loads a named compatibility profile before explicit model overrides", async () => {
    const configDir = await configDirectory();
    await writeFile(join(configDir, "models.json"), JSON.stringify({
      providers: {
        gateway: {
          api: "openai-completions",
          baseUrl: "https://gateway.example/v1",
          compat: { profile: "deepseek", supportsUsageInStreaming: false },
          models: [{ id: "reasoner", reasoning: true }],
        },
      },
    }));
    expect(resolveProviderSelection(
      await loadProviderCatalog({ configDir, env: {} }),
      "gateway",
    ).model.compat).toMatchObject({
      profile: "deepseek",
      thinkingFormat: "deepseek",
      supportsReasoningEffort: true,
      supportsUsageInStreaming: false,
    });
  });

  test("loads a named OpenAI-compatible provider and resolves its default model", async () => {
    const configDir = await configDirectory();
    await writeFile(
      join(configDir, "models.json"),
      JSON.stringify({
        providers: {
          deepseek: {
            name: "DeepSeek",
            api: "openai-completions",
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "$DEEPSEEK_API_KEY",
            headers: { "x-client": "tnb", "x-account": "$DEEPSEEK_ACCOUNT" },
            models: [
              {
                id: "deepseek-chat",
                name: "DeepSeek Chat",
                contextWindow: 64_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      }),
    );

    const catalog = await loadProviderCatalog({
      configDir,
      env: {
        DEEPSEEK_API_KEY: "secret",
        DEEPSEEK_ACCOUNT: "account-1",
      },
    });

    expect(resolveProviderSelection(catalog, "deepseek")).toEqual({
      provider: {
        id: "deepseek",
        name: "DeepSeek",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "secret",
        headers: { "x-client": "tnb", "x-account": "account-1" },
        models: [
          {
            id: "deepseek-chat",
            name: "DeepSeek Chat",
            contextWindow: 64_000,
            maxTokens: 8_192,
            reasoning: false,
            supportsVision: false,
            supportsPdf: false,
            compat: {},
            samplingParams: {},
          },
        ],
        compat: {},
      },
      model: {
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        contextWindow: 64_000,
        maxTokens: 8_192,
        reasoning: false,
        supportsVision: false,
        supportsPdf: false,
        compat: {},
        samplingParams: {},
      },
    });
  });

  test("keeps Anthropic and OpenAI as built-in providers without models.json", async () => {
    const configDir = await configDirectory();

    const catalog = await loadProviderCatalog({
      configDir,
      env: {
        ANTHROPIC_API_KEY: "anthropic-key",
        ANTHROPIC_BASE_URL: "https://anthropic-proxy.example",
        OPENAI_API_KEY: "openai-key",
        OPENAI_BASE_URL: "https://openai-proxy.example/v1",
      },
    });

    expect(resolveProviderSelection(catalog, "anthropic")).toMatchObject({
      provider: {
        id: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://anthropic-proxy.example",
        apiKey: "anthropic-key",
        promptCaching: "5m",
      },
      model: {
        id: "claude-sonnet-4-6",
        contextWindow: 200_000,
        maxTokens: 32_000,
        pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
    });
    expect(resolveProviderSelection(catalog, "openai", "gpt-4o")).toMatchObject({
      provider: {
        id: "openai",
        api: "openai-completions",
        baseUrl: "https://openai-proxy.example/v1",
        apiKey: "openai-key",
      },
      model: { id: "gpt-4o", contextWindow: 128_000, maxTokens: 16_384 },
    });
  });

  test("preserves arbitrary model ids for built-in protocol providers", async () => {
    const catalog = await loadProviderCatalog({
      configDir: await configDirectory(),
      env: {},
    });

    expect(resolveProviderSelection(catalog, "openai", "vendor-model").model).toMatchObject({
      id: "vendor-model",
      name: "vendor-model",
      contextWindow: 128_000,
      maxTokens: 16_384,
    });
    expect(resolveProviderSelection(catalog, "anthropic", "custom-claude").model.id).toBe(
      "custom-claude",
    );
  });

  test("interpolates environment values and normalizes the endpoint URL", async () => {
    const configDir = await configDirectory();
    await writeFile(
      join(configDir, "models.json"),
      JSON.stringify({
        providers: {
          gateway: {
            api: "openai-completions",
            baseUrl: "https://gateway.example/v1/",
            headers: {
              authorization: "Bearer ${GATEWAY_TOKEN}",
              "x-price": "$$5",
            },
            models: [{ id: "coder" }],
          },
        },
      }),
    );

    const catalog = await loadProviderCatalog({
      configDir,
      env: { GATEWAY_TOKEN: "secret" },
    });

    expect(catalog.providers.gateway).toMatchObject({
      baseUrl: "https://gateway.example/v1",
      headers: { authorization: "Bearer secret", "x-price": "$5" },
    });
  });

  test("rejects duplicate model ids and non-HTTP endpoints", async () => {
    const configDir = await configDirectory();
    await writeFile(
      join(configDir, "models.json"),
      JSON.stringify({
        providers: {
          invalid: {
            api: "openai-completions",
            baseUrl: "file:///tmp/model",
            models: [{ id: "same" }, { id: "same" }],
          },
        },
      }),
    );

    await expect(loadProviderCatalog({ configDir, env: {} })).rejects.toThrow(
      "Provider invalid.baseUrl must use http or https",
    );

    await writeFile(
      join(configDir, "models.json"),
      JSON.stringify({
        providers: {
          invalid: {
            api: "openai-completions",
            baseUrl: "https://gateway.example/v1",
            models: [{ id: "same" }, { id: "same" }],
          },
        },
      }),
    );
    await expect(loadProviderCatalog({ configDir, env: {} })).rejects.toThrow(
      "Provider invalid has duplicate model id: same",
    );
  });

  test("partially overrides a built-in provider while preserving its models and credentials", async () => {
    const configDir = await configDirectory();
    await writeFile(
      join(configDir, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            baseUrl: "https://gateway.example/openai/v1",
            headers: { "x-gateway": "$GATEWAY_HEADER" },
            modelOverrides: {
              "gpt-4o": {
                contextWindow: 200_000,
                maxTokens: 32_000,
                headers: { "x-model-route": "fast" },
                compat: {
                  supportsDeveloperRole: true,
                  maxTokensField: "max_tokens",
                  requiresToolResultName: true,
                  requiresAssistantAfterToolResult: true,
                },
              },
            },
          },
        },
      }),
    );

    const catalog = await loadProviderCatalog({
      configDir,
      env: { OPENAI_API_KEY: "openai-key", GATEWAY_HEADER: "gateway" },
    });

    expect(resolveProviderSelection(catalog, "openai", "gpt-4o")).toMatchObject({
      provider: {
        id: "openai",
        api: "openai-completions",
        baseUrl: "https://gateway.example/openai/v1",
        apiKey: "openai-key",
        headers: { "x-gateway": "gateway" },
      },
      model: {
        id: "gpt-4o",
        name: "GPT-4o",
        contextWindow: 200_000,
        maxTokens: 32_000,
        headers: { "x-model-route": "fast" },
        compat: {
          supportsDeveloperRole: true,
          maxTokensField: "max_tokens",
          requiresToolResultName: true,
          requiresAssistantAfterToolResult: true,
        },
      },
    });
  });

  test("loads an OpenAI Responses provider protocol", async () => {
    const configDir = await configDirectory();
    await writeFile(
      join(configDir, "models.json"),
      JSON.stringify({
        providers: {
          responses: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            apiKey: "$RESPONSES_API_KEY",
            models: [
              { id: "gpt-5", contextWindow: 400_000, maxTokens: 128_000, reasoning: true },
            ],
          },
        },
      }),
    );

    expect(resolveProviderSelection(await loadProviderCatalog({
      configDir,
      env: { RESPONSES_API_KEY: "secret" },
    }), "responses")).toMatchObject({
      provider: { api: "openai-responses" },
      model: { id: "gpt-5", reasoning: true },
    });
  });

  test("loads explicit prompt caching and model pricing", async () => {
    const configDir = await configDirectory();
    await writeFile(
      join(configDir, "models.json"),
      JSON.stringify({
        providers: {
          cached: {
            api: "anthropic-messages",
            baseUrl: "https://gateway.example/anthropic",
            promptCaching: "1h",
            models: [{
              id: "cached-model",
              pricing: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 },
            }],
          },
        },
      }),
    );

    expect(resolveProviderSelection(
      await loadProviderCatalog({ configDir, env: {} }),
      "cached",
    )).toMatchObject({
      provider: { promptCaching: "1h" },
      model: { pricing: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 } },
    });

    await writeFile(
      join(configDir, "models.json"),
      JSON.stringify({
        providers: {
          cached: {
            api: "anthropic-messages",
            baseUrl: "https://gateway.example/anthropic",
            promptCaching: "forever",
            models: [{ id: "cached-model", pricing: { input: 2, output: 8 } }],
          },
        },
      }),
    );
    await expect(loadProviderCatalog({ configDir, env: {} })).rejects.toThrow(
      'Provider cached.promptCaching must be false, "5m", or "1h"',
    );
  });
});
