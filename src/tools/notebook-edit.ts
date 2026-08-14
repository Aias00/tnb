import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { NOTEBOOK_EDIT_TOOL_PROMPT } from "../constants/tool-prompts";
import { defineTool } from "../core/tool";
import { currentWorkspaceRoot, type WorkspaceRootSource } from "../core/workspace-state";
import { assertToolPathInsideAllowedRoots, resolveWorkspaceRoot } from "../utils/workspace-path";

type CellType = "code" | "markdown";
type EditMode = "replace" | "insert" | "delete";

type NotebookEditInput = {
  notebook_path: string;
  cell_id?: string;
  new_source: string;
  cell_type?: CellType;
  edit_mode: EditMode;
};

type NotebookCell = Record<string, unknown> & {
  cell_type: string;
  id?: string;
  source: string | string[];
};

type Notebook = Record<string, unknown> & {
  cells: NotebookCell[];
  nbformat: number;
  nbformat_minor: number;
};

export function createNotebookEditTool(workspaceRoot: WorkspaceRootSource, additionalRoots: () => string[] = () => []) {
  return defineTool<NotebookEditInput>({
    name: "notebook_edit",
    description: NOTEBOOK_EDIT_TOOL_PROMPT,
    inputSchema: {
      type: "object",
      properties: {
        notebook_path: {
          type: "string",
          description: "Absolute or workspace-relative path to the Jupyter notebook (.ipynb).",
        },
        cell_id: {
          type: "string",
          description:
            "Cell id to edit, or a zero-based cell-N index. Insert adds after this cell; omit it to insert at the beginning.",
        },
        new_source: {
          type: "string",
          description: "Complete replacement source for the cell. Use an empty string when deleting.",
        },
        cell_type: {
          type: "string",
          enum: ["code", "markdown"],
          description: "New cell type. Required for insert; optional for replace.",
        },
        edit_mode: {
          type: "string",
          enum: ["replace", "insert", "delete"],
          description: "Cell operation. Defaults to replace.",
        },
      },
      required: ["notebook_path", "new_source"],
      additionalProperties: false,
    },
    access: "write",
    permissionRuleContent: ({ notebook_path }) => notebook_path,
    validate(input): NotebookEditInput {
      const value = requireObject(input);
      if (typeof value.notebook_path !== "string" || !value.notebook_path.trim()) {
        throw new Error("notebook_edit requires a non-empty notebook_path string");
      }
      if (extname(value.notebook_path) !== ".ipynb") {
        throw new Error("notebook_edit only supports Jupyter notebook (.ipynb) files");
      }
      if (typeof value.new_source !== "string") {
        throw new Error("notebook_edit requires a new_source string");
      }
      const editMode = value.edit_mode ?? "replace";
      if (editMode !== "replace" && editMode !== "insert" && editMode !== "delete") {
        throw new Error("notebook_edit edit_mode must be replace, insert, or delete");
      }
      if (
        value.cell_type !== undefined &&
        value.cell_type !== "code" &&
        value.cell_type !== "markdown"
      ) {
        throw new Error("notebook_edit cell_type must be code or markdown");
      }
      if (value.cell_id !== undefined && (typeof value.cell_id !== "string" || !value.cell_id)) {
        throw new Error("notebook_edit cell_id must be a non-empty string");
      }
      if (editMode === "insert" && value.cell_type === undefined) {
        throw new Error("notebook_edit cell_type is required when edit_mode is insert");
      }
      if (editMode !== "insert" && value.cell_id === undefined) {
        throw new Error("notebook_edit cell_id is required unless edit_mode is insert");
      }
      return {
        notebook_path: value.notebook_path,
        ...(value.cell_id !== undefined ? { cell_id: value.cell_id } : {}),
        new_source: value.new_source,
        ...(value.cell_type !== undefined ? { cell_type: value.cell_type } : {}),
        edit_mode: editMode,
      };
    },
    async execute(input, signal) {
      const root = resolveWorkspaceRoot(currentWorkspaceRoot(workspaceRoot));
      await assertToolPathInsideAllowedRoots(root, input.notebook_path, "write", additionalRoots());
      const target = resolve(root, input.notebook_path);
      const original = await readFile(target, { encoding: "utf8", signal });
      const notebook = parseNotebook(original);
      const cellIndex = findCellIndex(notebook, input.cell_id, input.edit_mode);

      if (input.edit_mode === "delete") {
        notebook.cells.splice(cellIndex, 1);
      } else if (input.edit_mode === "insert") {
        const id = supportsCellIds(notebook) ? newCellId() : undefined;
        notebook.cells.splice(
          cellIndex,
          0,
          input.cell_type === "markdown"
            ? {
                cell_type: "markdown",
                ...(id ? { id } : {}),
                source: input.new_source,
                metadata: {},
              }
            : {
                cell_type: "code",
                ...(id ? { id } : {}),
                source: input.new_source,
                metadata: {},
                execution_count: null,
                outputs: [],
              },
        );
      } else {
        const cell = notebook.cells[cellIndex];
        if (!cell) throw new Error(`Cell at index ${cellIndex} does not exist in notebook`);
        cell.source = input.new_source;
        if (cell.cell_type === "code") {
          cell.execution_count = null;
          cell.outputs = [];
        }
        if (input.cell_type) cell.cell_type = input.cell_type;
      }

      await writeFile(target, JSON.stringify(notebook, null, 1), { encoding: "utf8", signal });
      if (input.edit_mode === "delete") {
        return `Deleted cell ${input.cell_id} from ${input.notebook_path}`;
      }
      if (input.edit_mode === "insert") {
        const inserted = notebook.cells[cellIndex];
        return `Inserted cell ${inserted?.id ?? `cell-${cellIndex}`} in ${input.notebook_path}`;
      }
      return `Updated cell ${input.cell_id} in ${input.notebook_path}`;
    },
  });
}

function requireObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("notebook_edit input must be an object");
  }
  return input as Record<string, unknown>;
}

function parseNotebook(content: string): Notebook {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Notebook is not valid JSON");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as Record<string, unknown>).cells) ||
    typeof (value as Record<string, unknown>).nbformat !== "number" ||
    typeof (value as Record<string, unknown>).nbformat_minor !== "number"
  ) {
    throw new Error("Notebook does not have a valid Jupyter notebook structure");
  }
  const notebook = value as Notebook;
  for (const cell of notebook.cells) {
    if (
      typeof cell !== "object" ||
      cell === null ||
      typeof cell.cell_type !== "string" ||
      (typeof cell.source !== "string" && !Array.isArray(cell.source))
    ) {
      throw new Error("Notebook contains an invalid cell");
    }
  }
  return notebook;
}

function findCellIndex(notebook: Notebook, cellId: string | undefined, mode: EditMode): number {
  if (cellId === undefined) return 0;
  const byId = notebook.cells.findIndex((cell) => cell.id === cellId);
  const index = byId >= 0 ? byId : parseCellIndex(cellId);
  if (index === undefined) throw new Error(`Cell with ID "${cellId}" not found in notebook`);
  if (!notebook.cells[index]) throw new Error(`Cell with index ${index} does not exist in notebook`);
  return mode === "insert" ? index + 1 : index;
}

function parseCellIndex(cellId: string): number | undefined {
  const match = /^cell-(\d+)$/.exec(cellId);
  if (!match?.[1]) return undefined;
  return Number.parseInt(match[1], 10);
}

function supportsCellIds(notebook: Notebook): boolean {
  return notebook.nbformat > 4 || (notebook.nbformat === 4 && notebook.nbformat_minor >= 5);
}

function newCellId(): string {
  return Math.random().toString(36).slice(2, 15);
}
