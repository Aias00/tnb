import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchWorkspaceContent } from "../../src/services/workspace/content-search";

test("content search treats patterns literally and excludes dependency output", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-search-"));
  try {
    await writeFile(join(root, "a.ts"), "start\nneedle.*\nend\n");
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "hidden.ts"), "needle.*");
    const result = await searchWorkspaceContent(root, "needle.*");
    expect(result.matches).toEqual([{ file: "a.ts", line: 2, text: "needle.*", preview: ["1: start", "2: needle.*", "3: end"] }]);
    expect((await searchWorkspaceContent(root, "not found")).matches).toEqual([]);
    const controller = new AbortController(); controller.abort();
    await expect(searchWorkspaceContent(root, "needle", controller.signal)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("content search caps results and does not follow outside symlinks", async () => {
  const { symlink } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "tnb-search-cap-"));
  const outside = await mkdtemp(join(tmpdir(), "tnb-search-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "outside-only");
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    expect((await searchWorkspaceContent(root, "outside-only")).matches).toEqual([]);
    await Promise.all(Array.from({ length: 25 }, (_, i) => writeFile(join(root, `${i}.txt`), Array(10).fill("-needle").join("\n"))));
    const result = await searchWorkspaceContent(root, "-needle");
    expect(result.matches).toHaveLength(200); expect(result.truncated).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
