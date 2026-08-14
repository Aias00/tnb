import { defineTool } from "../core/tool";
import { relative, resolve, sep } from "node:path";
import { currentWorkspaceRoot, type WorkspaceRootSource } from "../core/workspace-state";
import {
  CodebaseIndexStore,
  type CodebaseInvestigationResult,
  type CodebaseQueryMode,
  type CodebaseSemanticProvider,
} from "../services/codebase";
import { assertToolPathInsideAllowedRoots, resolveWorkspaceRoot } from "../utils/workspace-path";
import type { CodebaseEmbeddingProvider } from "../services/codebase/embeddings";

type CodebaseInvestigatorInput = {
  query: string;
  path?: string;
  mode: CodebaseQueryMode;
  limit: number;
  maxSymbolsPerFile: number;
  includeSnippets: boolean;
  rebuild: boolean;
  extensions?: string[];
};

export function createCodebaseInvestigatorTool(
  workspaceRoot: WorkspaceRootSource,
  cacheDirectory?: string,
  embeddings?: CodebaseEmbeddingProvider,
  additionalRoots: () => string[] = () => [],
  semanticProviderForRoot?: (root: string) => CodebaseSemanticProvider | undefined,
) {
  const stores = new Map<string, CodebaseIndexStore>();
  return defineTool<CodebaseInvestigatorInput>({
    name: "codebase_investigator",
    description: [
      "Build a local semantic index for the workspace and return ranked codebase matches.",
      "Use it when grep/glob are too literal and you need symbol-aware discovery across files.",
      "It extracts symbols and code relationships locally; optional configured embeddings improve hybrid ranking.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Natural-language or symbol-oriented query, such as 'session export manager' or 'createWorkflowTool'.",
        },
        path: {
          type: "string",
          description: "Optional workspace-relative file or directory scope.",
        },
        mode: {
          type: "string",
          enum: ["hybrid", "symbol", "content", "path"],
          description: "Ranking strategy. hybrid is the default.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum result files to return. Defaults to 8.",
        },
        maxSymbolsPerFile: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Maximum matched symbols to show per file. Defaults to 4.",
        },
        includeSnippets: {
          type: "boolean",
          description: "Whether to include a few matching lines for each result. Defaults to true.",
        },
        rebuild: {
          type: "boolean",
          description: "Force a fresh index rebuild instead of reusing an unchanged cached index.",
        },
        extensions: {
          type: "array",
          items: { type: "string" },
          description: "Optional extension filter such as ['ts', '.tsx', 'md'].",
        },
      },
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permissionRuleContent: ({ path, query }) => path ?? query,
    validate(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("codebase_investigator input must be an object");
      }
      const value = input as Record<string, unknown>;
      const query = nonEmptyString(value.query, "codebase_investigator query");
      const mode = value.mode === undefined ? "hybrid" : enumString(value.mode, ["hybrid", "symbol", "content", "path"], "codebase_investigator mode");
      const limit = integerInRange(value.limit, 8, 1, 20, "codebase_investigator limit");
      const maxSymbolsPerFile = integerInRange(
        value.maxSymbolsPerFile,
        4,
        1,
        10,
        "codebase_investigator maxSymbolsPerFile",
      );
      const includeSnippets = booleanOrDefault(value.includeSnippets, true, "codebase_investigator includeSnippets");
      const rebuild = booleanOrDefault(value.rebuild, false, "codebase_investigator rebuild");
      const extensions = optionalStringArray(value.extensions, "codebase_investigator extensions");
      return {
        query,
        ...(typeof value.path === "string" && value.path.trim() ? { path: value.path.trim() } : {}),
        mode,
        limit,
        maxSymbolsPerFile,
        includeSnippets,
        rebuild,
        ...(extensions?.length ? { extensions } : {}),
      };
    },
    async execute(input, signal) {
      const primaryRoot = resolveWorkspaceRoot(currentWorkspaceRoot(workspaceRoot));
      let root = primaryRoot;
      let scopedPath = input.path;
      if (input.path) {
        await assertToolPathInsideAllowedRoots(primaryRoot, input.path, "read", additionalRoots());
        const absolute = resolve(primaryRoot, input.path);
        const externalRoot = additionalRoots().map(resolveWorkspaceRoot).find((candidate) =>
          absolute === candidate || absolute.startsWith(`${candidate}${sep}`)
        );
        if (externalRoot) {
          root = externalRoot;
          scopedPath = relative(externalRoot, absolute) || ".";
        }
      }
      let store = stores.get(root);
      if (!store) {
        const semantics = semanticProviderForRoot?.(root);
        store = new CodebaseIndexStore({
          ...(cacheDirectory ? { cacheDirectory } : {}),
          ...(embeddings ? { embeddings } : {}),
          ...(semantics ? { semantics } : {}),
        });
        stores.set(root, store);
      }
      const result = await store.investigate(root, input.query, { ...input, ...(scopedPath ? { path: scopedPath } : {}), signal });
      return renderInvestigation(result);
    },
  });
}

function renderInvestigation(result: CodebaseInvestigationResult): string {
  const header = [
    `Index root: ${result.index.root}`,
    `Indexed files: ${result.index.fileCount}`,
    `Indexed symbols: ${result.index.symbolCount}`,
    `Indexed relationships: ${result.index.relationCount}`,
    `Embedding provider: ${result.index.embeddingProvider ?? "disabled"}`,
    `Built at: ${result.index.builtAt}`,
    `Cache: ${result.index.source}`,
    `Files reused/indexed: ${result.index.reusedFileCount}/${result.index.indexedFileCount}`,
    `Query: ${result.query.text}`,
    `Mode: ${result.query.mode}`,
    ...(result.query.path ? [`Scope: ${result.query.path}`] : []),
    ...(result.query.extensions?.length ? [`Extensions: ${result.query.extensions.join(", ")}`] : []),
  ];
  if (!result.results.length) {
    return `${header.join("\n")}\nResults: none`;
  }
  const sections = result.results.map((entry, index) => {
    const lines = [
      `${index + 1}. ${entry.path} [${entry.language}] score=${entry.score}`,
      `   reasons: ${entry.reasons.join("; ") || "semantic match"}`,
      ...(entry.symbols.length
        ? [`   symbols: ${entry.symbols.map((symbol) => `${symbol.kind} ${symbol.name} @${symbol.line}`).join(" | ")}`]
        : []),
      ...(entry.relations.length
        ? [`   relations: ${entry.relations.map((relation) => `${relation.direction} ${relation.kind} ${relation.path}`).join(" | ")}`]
        : []),
      ...(entry.snippets?.length
        ? entry.snippets.map((snippet) => `   ${snippet.line}: ${snippet.text}`)
        : []),
    ];
    return lines.join("\n");
  });
  return `${header.join("\n")}\nResults:\n${sections.join("\n")}`;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function enumString<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function integerInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function booleanOrDefault(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}
