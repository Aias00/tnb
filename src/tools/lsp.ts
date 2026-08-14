import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { defineTool } from "../core/tool";
import { currentWorkspaceRoot, type WorkspaceRootSource } from "../core/workspace-state";
import { TnbLspManager } from "../services/lsp/manager";
import type { TnbLspFileDiagnostics, TnbLspLocation, TnbLspSymbol } from "../services/lsp/types";
import { assertToolPathInsideAllowedRoots, resolveWorkspaceRoot } from "../utils/workspace-path";

type TnbLspToolOperation = "diagnostics" | "hover" | "definition" | "references" | "symbols" |
  "workspaceSymbols" | "implementation" | "incomingCalls" | "outgoingCalls";

type TnbLspToolInput = {
  operation: TnbLspToolOperation;
  path: string;
  line?: number;
  character?: number;
  waitMs?: number;
  query?: string;
};

export function createLspTool(options: {
  workspaceRoot: WorkspaceRootSource;
  additionalRoots?: () => string[];
  managerForRoot(root: string): TnbLspManager;
}) {
  const additionalRoots = options.additionalRoots ?? (() => []);
  return defineTool<TnbLspToolInput>({
    name: "lsp",
    description: "Query language servers for diagnostics, hover text, definitions, implementations, references, symbols, and call hierarchy.",
    inputSchema: objectSchema(
      {
        operation: {
          type: "string",
          enum: ["diagnostics", "hover", "definition", "references", "symbols", "workspaceSymbols", "implementation", "incomingCalls", "outgoingCalls"],
          description: "The LSP operation to perform.",
        },
        path: {
          type: "string",
          description: "Absolute or workspace-relative path to the source file.",
        },
        line: {
          type: "integer",
          minimum: 1,
          description: "1-based line number for position-based operations.",
        },
        character: {
          type: "integer",
          minimum: 1,
          description: "1-based character number for position-based operations.",
        },
        waitMs: {
          type: "integer",
          minimum: 0,
          description: "Optional diagnostics wait time in milliseconds after opening the file.",
        },
        query: {
          type: "string",
          description: "Optional workspace symbol search query.",
        },
      },
      ["operation"],
    ),
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permissionRuleContent: ({ path }) => path,
    validate(input) {
      const value = requireObject(input);
      const operation = requireEnum<TnbLspToolOperation>(
        value.operation,
        "lsp operation",
        ["diagnostics", "hover", "definition", "references", "symbols", "workspaceSymbols", "implementation", "incomingCalls", "outgoingCalls"],
      );
      const path = operation === "workspaceSymbols" ? "" : requireString(value.path, "lsp path");
      const parsed: TnbLspToolInput = {
        operation,
        path,
        ...(value.waitMs === undefined ? {} : { waitMs: requireNonNegativeInteger(value.waitMs, "lsp waitMs") }),
        ...(value.query === undefined ? {} : { query: requireString(value.query, "lsp query") }),
      };
      if (["hover", "definition", "references", "implementation", "incomingCalls", "outgoingCalls"].includes(operation)) {
        parsed.line = requirePositiveInteger(value.line, "lsp line");
        parsed.character = requirePositiveInteger(value.character, "lsp character");
      }
      return parsed;
    },
    async execute(input, signal) {
      const root = resolveWorkspaceRoot(currentWorkspaceRoot(options.workspaceRoot));
      const manager = options.managerForRoot(root);
      if (input.operation === "workspaceSymbols") {
        return formatSymbols(root, await manager.workspaceSymbols(input.query ?? "", signal));
      }
      await assertToolPathInsideAllowedRoots(root, input.path, "read", additionalRoots());
      const resolvedPath = realpathSync(resolve(root, input.path));
      if (input.operation === "diagnostics") {
        const diagnostics = await manager.diagnosticsForFile(resolvedPath, {
          waitMs: input.waitMs ?? 300,
          signal,
        });
        return formatDiagnostics(resolvedPath, diagnostics);
      }
      if (input.operation === "symbols") {
        return formatSymbols(
          resolvedPath,
          await manager.documentSymbols(resolvedPath, signal),
        );
      }
      const position = {
        line: (input.line ?? 1) - 1,
        character: (input.character ?? 1) - 1,
      };
      if (input.operation === "hover") {
        const hover = await manager.hover(resolvedPath, position, signal);
        return hover
          ? `Hover for ${resolvedPath}:${input.line}:${input.character}\n\n${hover.contents}`
          : `No hover information for ${resolvedPath}:${input.line}:${input.character}`;
      }
      const locations = input.operation === "definition"
        ? await manager.definition(resolvedPath, position, signal)
        : input.operation === "references"
          ? await manager.references(resolvedPath, position, signal)
          : input.operation === "implementation"
            ? await manager.implementation(resolvedPath, position, signal)
            : await manager.callHierarchy(resolvedPath, position, input.operation === "incomingCalls" ? "incoming" : "outgoing", signal);
      return formatLocations(input.operation, resolvedPath, input.line ?? 1, input.character ?? 1, locations);
    },
  });
}

function formatDiagnostics(filePath: string, entries: TnbLspFileDiagnostics[]): string {
  const total = entries.reduce((sum, entry) => sum + entry.diagnostics.length, 0);
  if (total === 0) return `No diagnostics for ${filePath}`;
  const lines = [`Diagnostics for ${filePath} (${total})`];
  for (const entry of entries) {
    for (const diagnostic of entry.diagnostics) {
      lines.push(
        `${severityLabel(diagnostic.severity)} ${entry.serverName} ${diagnostic.startLine + 1}:${diagnostic.startCharacter + 1} ${diagnostic.message}`,
      );
    }
  }
  return lines.join("\n");
}

function formatLocations(
  operation: Exclude<TnbLspToolOperation, "diagnostics" | "hover" | "symbols" | "workspaceSymbols">,
  filePath: string,
  line: number,
  character: number,
  locations: TnbLspLocation[],
): string {
  if (locations.length === 0) {
    return `No ${operation} results for ${filePath}:${line}:${character}`;
  }
  return [
    `${capitalize(operation)} results for ${filePath}:${line}:${character} (${locations.length})`,
    ...locations.map((location) =>
      `${location.filePath}:${location.startLine + 1}:${location.startCharacter + 1}-${location.endLine + 1}:${location.endCharacter + 1}`),
  ].join("\n");
}

function formatSymbols(filePath: string, symbols: TnbLspSymbol[]): string {
  if (symbols.length === 0) return `No symbols for ${filePath}`;
  return [
    `Symbols for ${filePath} (${symbols.length})`,
    ...symbols.map((symbol) =>
      `${symbol.name} [${symbol.kind}] ${symbol.location.startLine + 1}:${symbol.location.startCharacter + 1}`),
  ].join("\n");
}

function severityLabel(severity: number): string {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 4:
      return "hint";
    default:
      return "info";
  }
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function requireObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("tool input must be an object");
  }
  return input as Record<string, unknown>;
}

function requireString(input: unknown, label: string): string {
  if (typeof input !== "string" || !input.trim()) throw new Error(`${label} must be a non-empty string`);
  return input;
}

function requirePositiveInteger(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return input;
}

function requireNonNegativeInteger(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return input;
}

function requireEnum<T extends string>(input: unknown, label: string, allowed: readonly T[]): T {
  if (typeof input !== "string" || !allowed.includes(input as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return input as T;
}

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}
