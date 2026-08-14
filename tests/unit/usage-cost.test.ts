import { describe, expect, test } from "bun:test";

import { calculateCostUsd } from "../../src/services/usage/cost";

describe("usage cost", () => {
  test("prices ordinary, cache-read, and cache-write tokens independently", () => {
    expect(calculateCostUsd(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      },
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    )).toBe(22.05);
  });

  test("falls back to ordinary input pricing when cache rates are unspecified", () => {
    expect(calculateCostUsd(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 500_000,
        cacheCreationInputTokens: 500_000,
      },
      { input: 2, output: 8 },
    )).toBe(2);
  });
});
