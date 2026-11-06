import { expect, test } from "bun:test";
import { WorkspaceFileIndex, rankWorkspaceFiles } from "../../src/services/workspace/file-index";

test("workspace index coalesces scanning, caches until expiry and isolates roots", async () => {
  let now = 0, calls = 0;
  const index = new WorkspaceFileIndex(async root => { calls++; await Bun.sleep(5); return [`${root}/file.ts`]; }, 100, () => now);
  const signal = new AbortController().signal;
  await Promise.all([index.files("a", signal), index.files("a", signal)]); expect(calls).toBe(1);
  await index.files("a", signal); expect(calls).toBe(1);
  now = 101; await index.files("a", signal); expect(calls).toBe(2);
  await index.files("b", signal); expect(calls).toBe(3);
  index.invalidate("a"); await index.files("a", signal); expect(calls).toBe(4);
});
test("cancelled caller does not poison another consumer's shared index", async () => {
  let complete!: (files: string[]) => void;
  const index = new WorkspaceFileIndex(() => new Promise(resolve => { complete = resolve; }));
  const cancelled = new AbortController(), active = new AbortController();
  const a = index.files("root", cancelled.signal), b = index.files("root", active.signal);
  cancelled.abort(); complete(["file.ts"]);
  expect(await a).toEqual([]); expect(await b).toEqual(["file.ts"]);
});
test("ranking prefers filename matches, supports subsequences and remembers choices", () => {
  const files = ["lib/widget.ts", "src/widget.ts", "other/wi-long-dget.ts", "src/unrelated.ts"];
  const ranked = rankWorkspaceFiles(files, "wdgt", ["src/widget.ts"]);
  expect(ranked[0]).toBe("src/widget.ts"); expect(ranked).not.toContain("src/unrelated.ts");
  const index = new WorkspaceFileIndex(async () => []);
  index.remember("a", "src/widget.ts"); expect(index.recent("a")).toEqual(["src/widget.ts"]); expect(index.recent("b")).toEqual([]);
});
