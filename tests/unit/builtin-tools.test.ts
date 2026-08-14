import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
} from "../../src/tools/builtins";

const directories: string[] = [];

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "tnb-tools-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("built-in tools", () => {
  test("reads a UTF-8 file", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "notes.txt"), "hello\n");
    const tool = createReadTool(cwd);

    expect(await tool.execute(tool.validate({ path: "notes.txt" }), new AbortController().signal)).toBe("hello\n");
  });

  test("writes a file and creates missing parent directories", async () => {
    const cwd = await workspace();
    const tool = createWriteTool(cwd);

    await tool.execute(tool.validate({ path: "new/notes.txt", content: "hello\n" }), new AbortController().signal);

    expect(await readFile(join(cwd, "new/notes.txt"), "utf8")).toBe("hello\n");
  });

  test("edits an exact unique string", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "notes.txt"), "before\n");
    const tool = createEditTool(cwd);

    await tool.execute(
      tool.validate({ path: "notes.txt", oldText: "before", newText: "after" }),
      new AbortController().signal,
    );

    expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe("after\n");
  });

  test("replaces every exact edit match only when replaceAll is explicit", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "notes.txt"), "old old older\n");
    const tool = createEditTool(cwd);

    await expect(tool.execute(
      tool.validate({ path: "notes.txt", oldText: "old", newText: "new" }),
      new AbortController().signal,
    )).rejects.toThrow("not unique");

    expect(await tool.execute(
      tool.validate({ path: "notes.txt", oldText: "old", newText: "new", replaceAll: true }),
      new AbortController().signal,
    )).toBe("Edited notes.txt: replaced 3 occurrences");
    expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe("new new newer\n");
  });

  test("runs a shell command in the workspace", async () => {
    const cwd = await workspace();
    const tool = createBashTool(cwd);

    await tool.execute(tool.validate({ command: "printf executed > ran.txt" }), new AbortController().signal);

    expect(await readFile(join(cwd, "ran.txt"), "utf8")).toBe("executed");
  });

  test("searches file contents with line and column locations while respecting ignore files", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, ".gitignore"), "ignored.ts\n");
    await writeFile(join(cwd, "src", "main.ts"), "const needle = true;\n");
    await writeFile(join(cwd, "ignored.ts"), "needle\n");
    const tool = createGrepTool(cwd);

    const output = await tool.execute(
      tool.validate({ pattern: "needle" }),
      new AbortController().signal,
    );

    expect(output).toContain("src/main.ts:1:7:const needle = true;");
    expect(output).not.toContain("ignored.ts");
  });

  test("reports an empty grep result without treating it as an error", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "notes.txt"), "hello\n");
    const tool = createGrepTool(cwd);

    expect(
      await tool.execute(tool.validate({ pattern: "absent" }), new AbortController().signal),
    ).toBe("No matches found");
  });

  test("filters grep results by glob without re-including ignored files", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, ".gitignore"), "ignored.ts\n");
    await writeFile(join(cwd, "main.ts"), "needle\n");
    await writeFile(join(cwd, "main.js"), "needle\n");
    await writeFile(join(cwd, "ignored.ts"), "needle\n");
    const tool = createGrepTool(cwd);

    const output = await tool.execute(
      tool.validate({ pattern: "needle", glob: "*.ts" }),
      new AbortController().signal,
    );

    expect(output).toBe("main.ts:1:1:needle");
  });

  test("reports no grep matches after applying a glob filter", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "main.js"), "needle\n");
    const tool = createGrepTool(cwd);

    expect(
      await tool.execute(
        tool.validate({ pattern: "needle", glob: "*.ts" }),
        new AbortController().signal,
      ),
    ).toBe("No matches found");
  });

  test("finds matching files in stable order while respecting ignore files", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, ".gitignore"), "ignored.ts\n");
    await writeFile(join(cwd, "src", "z.ts"), "");
    await writeFile(join(cwd, "src", "a.ts"), "");
    await writeFile(join(cwd, "src", "a.js"), "");
    await writeFile(join(cwd, "ignored.ts"), "");
    const tool = createGlobTool(cwd);

    expect(
      await tool.execute(tool.validate({ pattern: "*.ts" }), new AbortController().signal),
    ).toBe("src/a.ts\nsrc/z.ts");
  });

  test("rejects search paths outside the workspace", async () => {
    const cwd = await workspace();
    const grep = createGrepTool(cwd);
    const glob = createGlobTool(cwd);

    await expect(
      grep.execute(grep.validate({ pattern: "secret", path: ".." }), new AbortController().signal),
    ).rejects.toThrow("outside the workspace");
    await expect(
      glob.execute(glob.validate({ pattern: "*.txt", path: ".." }), new AbortController().signal),
    ).rejects.toThrow("outside the workspace");
  });

  test("marks file results that exceed the requested limit", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.ts"), "");
    await writeFile(join(cwd, "b.ts"), "");
    const tool = createGlobTool(cwd);

    expect(
      await tool.execute(
        tool.validate({ pattern: "*.ts", maxResults: 1 }),
        new AbortController().signal,
      ),
    ).toBe("a.ts\n(Results truncated; narrow the search or raise maxResults.)");
  });

  test("allows an explicit unlimited grep result count", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "needle one\nneedle two\n");
    const tool = createGrepTool(cwd);

    const output = await tool.execute(
      tool.validate({ pattern: "needle", maxResults: 0 }),
      new AbortController().signal,
    );

    expect(output).toContain("a.txt:1:1:needle one");
    expect(output).toContain("a.txt:2:1:needle two");
    expect(output).not.toContain("Results truncated");
  });

  test("caps unlimited grep output by the established character budget", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "large.txt"), `${"x".repeat(25_000)}\n`);
    const tool = createGrepTool(cwd);

    const output = await tool.execute(
      tool.validate({ pattern: "x", maxResults: 0 }),
      new AbortController().signal,
    );

    expect(output).toContain("Results truncated");
    expect(output.indexOf("\n(Results truncated")).toBeLessThanOrEqual(20_000);
  });

  test("explains when the ripgrep executable is unavailable", async () => {
    const cwd = await workspace();
    const tool = createGrepTool(cwd, { executable: "tnb-missing-rg" });

    await expect(
      tool.execute(tool.validate({ pattern: "anything" }), new AbortController().signal),
    ).rejects.toThrow("ripgrep executable was not found");
  });
});
