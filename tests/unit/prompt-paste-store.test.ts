import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PromptPasteStore } from "../../src/services/session/prompt-paste-store";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("prompt paste store", () => {
  test("keeps small text inline and stores large text by hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-paste-store-"));
    roots.push(root);
    const store = new PromptPasteStore(root);
    expect(await store.storeText(1, "x".repeat(1024))).toMatchObject({ type: "text", id: 1, content: "x".repeat(1024) });
    const large = "large\n".repeat(300);
    const stored = await store.storeText(2, large);
    expect(stored).toMatchObject({ type: "text", id: 2 });
    expect("contentHash" in stored).toBe(true);
    expect(await store.resolveText(stored)).toBe(large);
    if ("contentHash" in stored && stored.contentHash) {
      expect(await readFile(join(root, "prompt-pastes", stored.contentHash), "utf8")).toBe(large);
    }
  });

  test("deduplicates concurrent writes and rejects invalid hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-paste-store-concurrent-"));
    roots.push(root);
    const store = new PromptPasteStore(root);
    const text = "z".repeat(2048);
    const values = await Promise.all(Array.from({ length: 8 }, (_, index) => store.storeText(index + 1, text)));
    const hashes = new Set(values.map((value) => "contentHash" in value ? value.contentHash : undefined));
    expect(hashes.size).toBe(1);
    await expect(store.resolveText({ id: 1, type: "text", contentHash: "../bad" })).rejects.toThrow("Invalid prompt paste hash");
    expect(await store.resolveText({ id: 1, type: "text", contentHash: "0".repeat(64) })).toBeUndefined();
  });
});
