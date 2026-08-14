import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNotebookEditTool } from "../../src/tools/notebook-edit";

const directories: string[] = [];

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "tnb-notebook-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function notebook(cells: unknown[]) {
  return {
    cells,
    metadata: { language_info: { name: "python" } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

async function readNotebook(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as {
    cells: Array<Record<string, unknown>>;
  };
}

describe("notebook_edit tool", () => {
  test("replaces a cell by its real id and clears stale code output", async () => {
    const cwd = await workspace();
    const path = join(cwd, "analysis.ipynb");
    await writeFile(
      path,
      JSON.stringify(
        notebook([
          {
            cell_type: "code",
            id: "setup",
            source: ["print('old')\n"],
            metadata: { trusted: true },
            execution_count: 7,
            outputs: [{ output_type: "stream", text: ["old\n"] }],
          },
        ]),
      ),
    );
    const tool = createNotebookEditTool(cwd);

    const result = await tool.execute(
      tool.validate({
        notebook_path: "analysis.ipynb",
        cell_id: "setup",
        new_source: "print('new')",
      }),
      new AbortController().signal,
    );

    const updated = await readNotebook(path);
    expect(updated.cells[0]).toEqual({
      cell_type: "code",
      id: "setup",
      source: "print('new')",
      metadata: { trusted: true },
      execution_count: null,
      outputs: [],
    });
    expect(result).toBe("Updated cell setup in analysis.ipynb");
  });

  test("inserts after a cell-N index and creates a valid markdown cell", async () => {
    const cwd = await workspace();
    const path = join(cwd, "analysis.ipynb");
    await writeFile(
      path,
      JSON.stringify(
        notebook([
          { cell_type: "code", id: "first", source: "x = 1", metadata: {}, execution_count: null, outputs: [] },
          { cell_type: "code", id: "last", source: "x", metadata: {}, execution_count: null, outputs: [] },
        ]),
      ),
    );
    const tool = createNotebookEditTool(cwd);

    const result = await tool.execute(
      tool.validate({
        notebook_path: "analysis.ipynb",
        cell_id: "cell-0",
        new_source: "# Notes",
        cell_type: "markdown",
        edit_mode: "insert",
      }),
      new AbortController().signal,
    );

    const updated = await readNotebook(path);
    expect(updated.cells.map((cell) => cell.id)).toEqual([
      "first",
      expect.stringMatching(/^[a-z0-9]+$/),
      "last",
    ]);
    expect(updated.cells[1]).toMatchObject({
      cell_type: "markdown",
      source: "# Notes",
      metadata: {},
    });
    expect(updated.cells[1]).not.toHaveProperty("outputs");
    expect(result).toContain("Inserted cell ");
  });

  test("inserts at the beginning when cell_id is omitted", async () => {
    const cwd = await workspace();
    const path = join(cwd, "analysis.ipynb");
    await writeFile(
      path,
      JSON.stringify(
        notebook([
          { cell_type: "markdown", id: "existing", source: "old", metadata: {} },
        ]),
      ),
    );
    const tool = createNotebookEditTool(cwd);

    await tool.execute(
      tool.validate({
        notebook_path: "analysis.ipynb",
        new_source: "x = 1",
        cell_type: "code",
        edit_mode: "insert",
      }),
      new AbortController().signal,
    );

    const updated = await readNotebook(path);
    expect(updated.cells[0]).toMatchObject({
      cell_type: "code",
      source: "x = 1",
      metadata: {},
      execution_count: null,
      outputs: [],
    });
    expect(updated.cells[1]?.id).toBe("existing");
  });

  test("deletes a cell by id", async () => {
    const cwd = await workspace();
    const path = join(cwd, "analysis.ipynb");
    await writeFile(
      path,
      JSON.stringify(
        notebook([
          { cell_type: "markdown", id: "remove", source: "old", metadata: {} },
          { cell_type: "markdown", id: "keep", source: "new", metadata: {} },
        ]),
      ),
    );
    const tool = createNotebookEditTool(cwd);

    expect(
      await tool.execute(
        tool.validate({
          notebook_path: "analysis.ipynb",
          cell_id: "remove",
          new_source: "",
          edit_mode: "delete",
        }),
        new AbortController().signal,
      ),
    ).toBe("Deleted cell remove from analysis.ipynb");

    expect((await readNotebook(path)).cells.map((cell) => cell.id)).toEqual(["keep"]);
  });

  test("rejects invalid modes, missing identifiers, and non-notebook files", () => {
    const tool = createNotebookEditTool(process.cwd());

    expect(() =>
      tool.validate({ notebook_path: "a.ipynb", new_source: "x", edit_mode: "insert" }),
    ).toThrow("cell_type is required");
    expect(() => tool.validate({ notebook_path: "a.ipynb", new_source: "x" })).toThrow(
      "cell_id is required",
    );
    expect(() =>
      tool.validate({ notebook_path: "a.txt", cell_id: "cell-0", new_source: "x" }),
    ).toThrow(".ipynb");
    expect(() =>
      tool.validate({
        notebook_path: "a.ipynb",
        cell_id: "cell-0",
        new_source: "x",
        edit_mode: "append",
      }),
    ).toThrow("edit_mode");
  });

  test("rejects invalid notebook JSON, missing cells, and paths outside the workspace", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "invalid.ipynb"), "not json");
    await writeFile(join(cwd, "analysis.ipynb"), JSON.stringify(notebook([])));
    const tool = createNotebookEditTool(cwd);

    await expect(
      tool.execute(
        tool.validate({ notebook_path: "invalid.ipynb", cell_id: "cell-0", new_source: "x" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("not valid JSON");
    await expect(
      tool.execute(
        tool.validate({ notebook_path: "analysis.ipynb", cell_id: "cell-0", new_source: "x" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("index 0 does not exist");
    await expect(
      tool.execute(
        tool.validate({ notebook_path: "../outside.ipynb", cell_id: "cell-0", new_source: "x" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("outside the workspace");
  });
});
