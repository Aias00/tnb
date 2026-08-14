import { describe, expect, test } from "bun:test";

import {
  buildSmokeCatalog,
  mergeProviderSmokeSummaries,
  renderProviderSmokeSummary,
  resolveProviderSmokeCase,
  runConfiguredProviderSmokeMatrix,
  runProviderSmokeMatrix,
} from "../../src/providers/smoke-matrix";

describe("provider smoke matrix", () => {
  test("skips providers whose credentials are absent", () => {
    expect(resolveProviderSmokeCase({
      id: "deepseek",
      name: "DeepSeek",
      credentialEnv: ["DEEPSEEK_API_KEY"],
      apiKeyEnv: ["DEEPSEEK_API_KEY"],
      defaultBaseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-v4-pro",
      compatProfile: "deepseek",
    }, {})).toEqual({
      status: "skipped",
      provider: { id: "deepseek", name: "DeepSeek" },
      missingEnv: ["DEEPSEEK_API_KEY"],
    });
  });

  test("builds a provider catalog with the expected compatibility profile", () => {
    const catalog = buildSmokeCatalog({
      id: "qwen",
      name: "Qwen",
      apiKey: "secret",
      baseUrl: "https://dashscope.example/v1",
      model: "qwen-plus",
      reasoning: true,
      compatProfile: "qwen",
    });

    expect(catalog.providers.qwen).toMatchObject({
      api: "openai-completions",
      apiKey: "secret",
      baseUrl: "https://dashscope.example/v1",
      compat: { profile: "qwen" },
      models: [{
        id: "qwen-plus",
        reasoning: true,
        compat: { profile: "qwen" },
      }],
    });
  });

  test("aggregates passed, skipped, and failed probes", async () => {
    const calls: Array<{ provider: string; probe: "text" | "tool-use" }> = [];
    const summary = await runProviderSmokeMatrix({
      providers: ["deepseek", "glm", "openrouter"],
      cwd: process.cwd(),
      env: {
        DEEPSEEK_API_KEY: "deepseek-key",
        GLM_API_KEY: "glm-key",
      },
      runCommand: async (args) => {
        const provider = args[4]!;
        const probe = args.includes("--tools") ? "tool-use" : "text";
        calls.push({ provider, probe });
        if (provider === "glm") {
          return { exitCode: 1, stdout: "", stderr: "provider rejected request" };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            provider,
            api: "openai-completions",
            endpoint: `https://${provider}.example/v1`,
            model: provider === "deepseek" ? "deepseek-v4-pro" : "~openai/gpt-latest",
            probe,
            stopReason: probe === "tool-use" ? "tool-use" : "end-turn",
            eventCount: probe === "tool-use" ? 3 : 2,
            usage: { inputTokens: 12, outputTokens: 3 },
            ...(probe === "text"
              ? { text: "OK" }
              : { toolCall: { name: "provider_diagnostic", input: { value: "ok" } } }),
          }),
          stderr: "",
        };
      },
    });

    expect(summary).toMatchObject({
      passed: 1,
      skipped: 1,
      failed: 1,
    });
    expect(summary.results).toEqual([
      expect.objectContaining({
        status: "failed",
        provider: { id: "glm", name: "GLM" },
      }),
      expect.objectContaining({
        status: "passed",
        provider: expect.objectContaining({ id: "deepseek", model: "deepseek-v4-pro" }),
      }),
      expect.objectContaining({
        status: "skipped",
        provider: { id: "openrouter", name: "OpenRouter" },
      }),
    ]);
    expect(calls).toEqual([
      { provider: "glm", probe: "text" },
      { provider: "deepseek", probe: "text" },
      { provider: "deepseek", probe: "tool-use" },
    ]);
    expect(renderProviderSmokeSummary(summary)).toContain("summary: passed=1 skipped=1 failed=1");
  });

  test("runs configured providers without copying credentials into a temporary catalog", async () => {
    const calls: string[][] = [];
    const summary = await runConfiguredProviderSmokeMatrix({
      providers: ["yuanjing"],
      catalog: {
        providers: {
          yuanjing: {
            id: "yuanjing",
            name: "Yuanjing GLM",
            api: "anthropic-messages",
            baseUrl: "https://yuanjing.example",
            headers: { Authorization: "secret" },
            compat: { anthropicRequiredToolChoice: "auto" },
            models: [{
              id: "glm-5",
              name: "GLM-5",
              contextWindow: 200_000,
              maxTokens: 32_000,
              reasoning: true,
              supportsVision: false,
              supportsPdf: false,
              compat: { anthropicRequiredToolChoice: "auto" },
              samplingParams: {},
            }],
          },
        },
      },
      env: { TNB_HOME: "/tmp/existing-tnb-home" },
      runCommand: async (args) => {
        calls.push(args);
        const probe = args.includes("--tools") ? "tool-use" : "text";
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            provider: "yuanjing",
            api: "anthropic-messages",
            endpoint: "https://yuanjing.example",
            model: "glm-5",
            probe,
            stopReason: probe === "tool-use" ? "tool-use" : "end-turn",
            eventCount: 3,
            usage: { inputTokens: 12, outputTokens: 3 },
            ...(probe === "text"
              ? { text: "OK" }
              : { toolCall: { name: "provider_diagnostic", input: { value: "ok" } } }),
          }),
          stderr: "",
        };
      },
    });

    expect(summary).toMatchObject({ passed: 1, skipped: 0, failed: 0 });
    expect(summary.results[0]).toMatchObject({
      status: "passed",
      provider: { id: "yuanjing", name: "Yuanjing GLM", model: "glm-5" },
    });
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(calls).toHaveLength(2);
  });

  test("merges environment and configured provider summaries", () => {
    expect(mergeProviderSmokeSummaries(
      {
        results: [{
          status: "skipped",
          provider: { id: "openrouter", name: "OpenRouter" },
          missingEnv: ["OPENROUTER_API_KEY"],
        }],
        passed: 0,
        skipped: 1,
        failed: 0,
      },
      {
        results: [{
          status: "failed",
          provider: { id: "local", name: "Local" },
          error: "connection refused",
        }],
        passed: 0,
        skipped: 0,
        failed: 1,
      },
    )).toMatchObject({ passed: 0, skipped: 1, failed: 1 });
  });

  test("fails a configured provider when streamed usage omits input tokens", async () => {
    const summary = await runConfiguredProviderSmokeMatrix({
      providers: ["local"],
      catalog: {
        providers: {
          local: {
            id: "local",
            name: "Local",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:8000/v1",
            headers: {},
            compat: {},
            models: [{
              id: "local-model",
              name: "Local model",
              contextWindow: 8_192,
              maxTokens: 1_024,
              reasoning: false,
              supportsVision: false,
              supportsPdf: false,
              compat: {},
              samplingParams: {},
            }],
          },
        },
      },
      env: {},
      runCommand: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          ok: true,
          provider: "local",
          api: "openai-completions",
          endpoint: "http://127.0.0.1:8000/v1",
          model: "local-model",
          probe: "text",
          stopReason: "end-turn",
          eventCount: 2,
          text: "OK",
          usage: { inputTokens: 0, outputTokens: 1 },
        }),
      }),
    });

    expect(summary).toMatchObject({ passed: 0, failed: 1 });
    expect(summary.results[0]).toMatchObject({
      status: "failed",
      error: "local text probe reported invalid input token usage",
    });
  });
});
