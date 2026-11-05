import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
import { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } from "../../src/utils/file-state-cache";

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
  test("pages UTF-8 bytes without splitting characters and rejects partial mutation receipts", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "notes.txt"), "a中😀z");
    const cache = createFileStateCacheWithSizeLimit(100);
    const read = createReadTool(cwd, undefined, undefined, cache);
    const signal = new AbortController().signal;
    expect(await read.execute(read.validate({ path: "notes.txt", limit: 2 }), signal)).toContain("Next offset: 4.");
    expect(await read.execute(read.validate({ path: "notes.txt", offset: 4, limit: 1 }), signal)).toEndWith("😀");
    const edit = createEditTool(cwd, undefined, cache);
    await expect(edit.execute(edit.validate({ path: "notes.txt", oldText: "a", newText: "b" }), signal)).rejects.toThrow("has not been read");
    const write = createWriteTool(cwd, undefined, cache);
    await expect(write.execute(write.validate({ path: "notes.txt", content: "replacement" }), signal)).rejects.toThrow("has not been read");
    await expect(read.execute(read.validate({ path: "notes.txt", offset: 2 }), signal)).rejects.toThrow("UTF-8");
    expect(await read.execute(read.validate({ path: "notes.txt", limit: 64 }), signal)).toBe("a中😀z");
    await edit.execute(edit.validate({ path: "notes.txt", oldText: "a", newText: "b" }), signal);
    expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe("b中😀z");
  });

  test("caps default text reads, supports continuation, and grants a receipt only for a whole file", async () => {
    const cwd = await workspace();
    const content = "x".repeat(100_000) + "end";
    await writeFile(join(cwd, "large.txt"), content);
    const cache = createFileStateCacheWithSizeLimit(100);
    const read = createReadTool(cwd, undefined, undefined, cache);
    const signal = new AbortController().signal;
    const first = await read.execute(read.validate({ path: "large.txt" }), signal);
    expect(first).toContain("Next offset: 65536.");
    expect((first as string).length).toBeLessThan(66_000);
    const last = await read.execute(read.validate({ path: "large.txt", offset: 65536 }), signal);
    expect(last).toContain("End of file.");
    expect(cache.get(join(await realpath(cwd), "large.txt"))?.isPartialView).toBe(true);
    expect(await read.execute(read.validate({ path: "large.txt", limit: 1048576 }), signal)).toBe(content);
    expect(cache.get(join(await realpath(cwd), "large.txt"))?.isPartialView).toBe(false);
    for (const input of [{ limit: 1048577 }, { offset: -1 }, { limit: 1.5 }]) {
      expect(() => read.validate({ path: "large.txt", ...input })).toThrow();
    }
    await writeFile(join(cwd, "binary.txt"), Buffer.from([97, 0, 98]));
    await expect(read.execute(read.validate({ path: "binary.txt" }), signal)).rejects.toThrow("binary");
  });

  test("refuses oversized mutation inputs even if a previously read file grows", async () => {
    const cwd = await workspace();
    const path = "growing.txt";
    const cache = createFileStateCacheWithSizeLimit(100);
    const read = createReadTool(cwd, undefined, undefined, cache);
    const signal = new AbortController().signal;
    await writeFile(join(cwd, path), "small");
    await read.execute(read.validate({ path }), signal);
    await writeFile(join(cwd, path), "x".repeat(1048580));
    const edit = createEditTool(cwd, undefined, cache);
    await expect(edit.execute(edit.validate({ path, oldText: "x", newText: "y" }), signal)).rejects.toThrow("mutation limit");
    const write = createWriteTool(cwd, undefined, cache);
    await expect(write.execute(write.validate({ path, content: "replacement" }), signal)).rejects.toThrow("mutation limit");
    expect((await readFile(join(cwd, path))).length).toBe(1048580);
  });

  test("reads only a bounded page from a very large sparse file", async () => {
    const cwd = await workspace();
    const file = await open(join(cwd, "sparse.txt"), "w");
    try { await file.write(Buffer.alloc(65540, 120)); await file.truncate(512 * 1024 * 1024); }
    finally { await file.close(); }
    const read = createReadTool(cwd);
    const result = await read.execute(read.validate({ path: "sparse.txt" }), new AbortController().signal);
    expect(result).toContain("of 536870912");
    expect(result).toContain("Next offset: 65536");
    expect((result as string).length).toBeLessThan(66000);
  });

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
    const fileState = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE);
    const read = createReadTool(cwd, undefined, undefined, fileState);
    const tool = createEditTool(cwd, undefined, fileState);
    await read.execute(read.validate({ path: "notes.txt" }), new AbortController().signal);

    await tool.execute(
      tool.validate({ path: "notes.txt", oldText: "before", newText: "after" }),
      new AbortController().signal,
    );

    expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe("after\n");
  });

  test("replaces every exact edit match only when replaceAll is explicit", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "notes.txt"), "old old older\n");
    const fileState = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE);
    const read = createReadTool(cwd, undefined, undefined, fileState);
    const tool = createEditTool(cwd, undefined, fileState);
    await read.execute(read.validate({ path: "notes.txt" }), new AbortController().signal);

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

  test("requires an existing file to be read before write or edit", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "notes.txt"), "before\n");

    await expect(createWriteTool(cwd).execute(
      createWriteTool(cwd).validate({ path: "notes.txt", content: "after\n" }),
      new AbortController().signal,
    )).rejects.toThrow("has not been read");
    await expect(createEditTool(cwd).execute(
      createEditTool(cwd).validate({ path: "notes.txt", oldText: "before", newText: "after" }),
      new AbortController().signal,
    )).rejects.toThrow("has not been read");
  });

  test("rejects write and edit after the file changes since read", async () => {
    const cwd = await workspace();
    const target = join(cwd, "notes.txt");
    await writeFile(target, "observed\n");
    const fileState = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE);
    const read = createReadTool(cwd, undefined, undefined, fileState);
    const write = createWriteTool(cwd, undefined, fileState);
    const edit = createEditTool(cwd, undefined, fileState);
    await read.execute(read.validate({ path: "notes.txt" }), new AbortController().signal);
    await writeFile(target, "external change\n");

    await expect(write.execute(
      write.validate({ path: "notes.txt", content: "replacement\n" }),
      new AbortController().signal,
    )).rejects.toThrow("modified since read");
    await expect(edit.execute(
      edit.validate({ path: "notes.txt", oldText: "external", newText: "internal" }),
      new AbortController().signal,
    )).rejects.toThrow("modified since read");
    expect(await readFile(target, "utf8")).toBe("external change\n");
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
