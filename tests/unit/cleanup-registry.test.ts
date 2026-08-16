import { describe, expect, test } from "bun:test";

import {
  registerCleanup,
  runCleanupFunctions,
} from "../../src/utils/cleanup-registry";

describe("cleanup registry", () => {
  test("runs every registered cleanup even when one fails", async () => {
    const calls: string[] = [];
    const unregisterFirst = registerCleanup(async () => {
      calls.push("first");
      throw new Error("cleanup failed");
    });
    const unregisterSecond = registerCleanup(async () => {
      calls.push("second");
    });

    await expect(runCleanupFunctions()).resolves.toBeUndefined();
    expect(calls).toEqual(["first", "second"]);
    unregisterFirst();
    unregisterSecond();
  });

  test("unregisters a cleanup before shutdown", async () => {
    const calls: string[] = [];
    const unregister = registerCleanup(async () => void calls.push("removed"));
    unregister();

    await runCleanupFunctions();
    expect(calls).toEqual([]);
  });
});
