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

test("completes at the cursor, preserving trailing instructions and quoting spaces", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tnb-completion-"));
  try {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "my file.ts"), "");
    const input = "inspect @src/my old.ts and explain";
    const cursor = "inspect @src/my".length;
    const values = await completeWorkspaceFiles(input, cwd, new AbortController().signal, cursor);
    // An unquoted token ends at whitespace; the rest of the instruction remains untouched.
    expect(values).toContain('inspect @"src/my file.ts" old.ts and explain');
  } finally { await import("node:fs/promises").then(fs => fs.rm(cwd, { recursive: true, force: true })); }
});

test("@ filename search discovers nested files and ignores symlink escapes", async () => {
  const { rm, symlink } = await import("node:fs/promises");
  const cwd = await mkdtemp(join(tmpdir(), "tnb-completion-"));
  const outside = await mkdtemp(join(tmpdir(), "tnb-outside-"));
  try {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "widget.ts"), "");
    await writeFile(join(outside, "secret.txt"), "");
    await symlink(outside, join(cwd, "external"));
    const signal = new AbortController().signal;
    expect(await completeWorkspaceFiles("read @widget", cwd, signal)).toContain("read @src/widget.ts");
    expect(await completeWorkspaceFiles("read @external/", cwd, signal)).toEqual([]);
    const aborted = new AbortController(); aborted.abort();
    expect(await completeWorkspaceFiles("@widget", cwd, aborted.signal)).toEqual([]);
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
