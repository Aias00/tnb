import { describe, expect, test } from "bun:test";

import {
  getAutoCompactThreshold,
  getAutoCompactThresholdForCapabilities,
  getModelCapabilities,
  MODEL_DEFAULTS,
} from "../../src/providers/models";

describe("model capabilities", () => {
  test("uses the established default context and output budgets", () => {
    expect(MODEL_DEFAULTS).toEqual({
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_000,
      compactMaxOutputTokens: 20_000,
      autoCompactBufferTokens: 13_000,
    });
    expect(getModelCapabilities("claude-sonnet")).toEqual({
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_000,
    });
  });

  test("derives the compact threshold from the effective model window", () => {
    expect(getAutoCompactThreshold("claude-sonnet")).toBe(167_000);
    expect(getAutoCompactThreshold("claude-sonnet[1m]")).toBe(967_000);
  });

  test("derives the compact threshold from configured model capabilities", () => {
    expect(
      getAutoCompactThresholdForCapabilities({
        contextWindowTokens: 64_000,
        maxOutputTokens: 8_192,
      }),
    ).toBe(42_808);
  });

  test("uses provider-specific OpenAI model capabilities", () => {
    expect(getModelCapabilities("gpt-4o", "openai")).toEqual({
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
    });
    expect(getModelCapabilities("gpt-4.1-2025-04-14", "openai")).toEqual({
      contextWindowTokens: 1_047_576,
      maxOutputTokens: 32_768,
    });
    expect(getModelCapabilities("o3-2025-04-16", "openai")).toEqual({
      contextWindowTokens: 200_000,
      maxOutputTokens: 100_000,
    });
    expect(getModelCapabilities("gpt-5.1-2025-11-13", "openai")).toEqual({
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
    });
  });

  test("uses a conservative OpenAI default for unlisted compatible models", () => {
    expect(getModelCapabilities("vendor-model", "openai")).toEqual({
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
    });
    expect(getAutoCompactThreshold("vendor-model", "openai")).toBe(98_616);
  });

  test("derives OpenAI compact thresholds from each model capability", () => {
    expect(getAutoCompactThreshold("gpt-4o", "openai")).toBe(98_616);
    expect(getAutoCompactThreshold("gpt-4.1", "openai")).toBe(1_014_576);
    expect(getAutoCompactThreshold("o3", "openai")).toBe(167_000);
    expect(getAutoCompactThreshold("gpt-5.1", "openai")).toBe(367_000);
  });

  test("applies the one-million suffix only to Anthropic models", () => {
    expect(getModelCapabilities("vendor-model[1m]", "openai")).toEqual({
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
    });
  });
});
