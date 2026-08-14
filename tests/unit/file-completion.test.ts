import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeWorkspaceFiles } from "../../src/ui/file-completion";

describe("workspace file completion", () => {
  test("completes @ references and nested path tokens inside the workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tnb-completion-"));
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "provider.ts"), "export {}\n");
    await writeFile(join(cwd, "src", "prompt.ts"), "export {}\n");
    const signal = new AbortController().signal;
    expect(await completeWorkspaceFiles("read @sr", cwd, signal)).toContain("read @src/");
    expect(await completeWorkspaceFiles("edit src/pro", cwd, signal)).toEqual([
      "edit src/prompt.ts",
      "edit src/provider.ts",
    ]);
  });

  test("does not complete ordinary words or paths outside the workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tnb-completion-"));
    const signal = new AbortController().signal;
    expect(await completeWorkspaceFiles("ordinary", cwd, signal)).toEqual([]);
    expect(await completeWorkspaceFiles("@../", cwd, signal)).toEqual([]);
    expect(await completeWorkspaceFiles("/tmp/", cwd, signal)).toEqual([]);
  });
});
