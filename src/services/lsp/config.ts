import { accessSync, constants } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import type { TnbLspServerConfig } from "./types";

type LspConfigEntry = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  extensionToLanguage: Record<string, string>;
  initializationOptions?: unknown;
  traceStderr?: boolean;
  disabled?: boolean;
};

const DISCOVERED_SERVERS: Record<string, LspConfigEntry> = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    extensionToLanguage: {
      ".ts": "typescript", ".tsx": "typescriptreact",
      ".js": "javascript", ".jsx": "javascriptreact",
      ".mjs": "javascript", ".cjs": "javascript",
    },
  },
  pyright: {
    command: "pyright-langserver",
    args: ["--stdio"],
    extensionToLanguage: { ".py": "python", ".pyi": "python" },
  },
  gopls: {
    command: "gopls",
    extensionToLanguage: { ".go": "go" },
  },
  rust: {
    command: "rust-analyzer",
    extensionToLanguage: { ".rs": "rust" },
  },
  clangd: {
    command: "clangd",
    extensionToLanguage: {
      ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp",
    },
  },
};

export async function loadLspServerConfigs(options: {
  configDir: string;
  cwd: string;
  env: Record<string, string | undefined>;
  which?: (command: string) => string | null;
}): Promise<TnbLspServerConfig[]> {
  const which = options.which ?? ((command: string) => findExecutable(command, options.env));
  const entries = new Map<string, LspConfigEntry>();
  for (const [name, entry] of Object.entries(DISCOVERED_SERVERS)) {
    if (resolveExecutable(entry.command, which)) entries.set(name, entry);
  }
  for (const filePath of [join(options.configDir, "lsp.json"), join(options.cwd, ".tnb", "lsp.json")]) {
    const configured = await readLspConfig(filePath);
    for (const [name, entry] of Object.entries(configured)) {
      if (entry.disabled) entries.delete(name);
      else entries.set(name, entry);
    }
  }
  return [...entries.entries()].map(([name, entry]) => ({
    name,
    command: resolveExecutable(entry.command, which) ?? entry.command,
    ...(entry.args ? { args: entry.args } : {}),
    ...(entry.env ? { env: entry.env } : {}),
    ...(entry.cwd ? { cwd: resolve(options.cwd, entry.cwd) } : {}),
    selectors: selectorsFromMap(entry.extensionToLanguage),
    ...(entry.initializationOptions !== undefined ? { initializationOptions: entry.initializationOptions } : {}),
    ...(entry.traceStderr !== undefined ? { traceStderr: entry.traceStderr } : {}),
  }));
}

async function readLspConfig(filePath: string): Promise<Record<string, LspConfigEntry>> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid LSP configuration JSON: ${filePath}`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`LSP configuration must be an object: ${filePath}`);
  const servers = isRecord(value.servers) ? value.servers : value;
  return Object.fromEntries(Object.entries(servers).map(([name, entry]) => [name, parseEntry(name, entry, filePath)]));
}

function parseEntry(name: string, input: unknown, filePath: string): LspConfigEntry {
  if (!isRecord(input)) throw new Error(`LSP server ${name} must be an object: ${filePath}`);
  if (input.disabled === true) {
    return { command: "disabled", extensionToLanguage: {}, disabled: true };
  }
  if (typeof input.command !== "string" || !input.command.trim()) {
    throw new Error(`LSP server ${name}.command must be a non-empty string: ${filePath}`);
  }
  if (!isRecord(input.extensionToLanguage) || Object.keys(input.extensionToLanguage).length === 0) {
    throw new Error(`LSP server ${name}.extensionToLanguage must be a non-empty object: ${filePath}`);
  }
  if (Object.values(input.extensionToLanguage).some((value) => typeof value !== "string" || !value)) {
    throw new Error(`LSP server ${name}.extensionToLanguage values must be language IDs: ${filePath}`);
  }
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string"))) {
    throw new Error(`LSP server ${name}.args must be an array of strings: ${filePath}`);
  }
  if (input.env !== undefined && (!isRecord(input.env) || Object.values(input.env).some((value) => typeof value !== "string"))) {
    throw new Error(`LSP server ${name}.env must contain string values: ${filePath}`);
  }
  return {
    command: input.command,
    ...(input.args ? { args: input.args as string[] } : {}),
    ...(input.env ? { env: input.env as Record<string, string> } : {}),
    ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
    extensionToLanguage: input.extensionToLanguage as Record<string, string>,
    ...(input.initializationOptions !== undefined ? { initializationOptions: input.initializationOptions } : {}),
    ...(typeof input.traceStderr === "boolean" ? { traceStderr: input.traceStderr } : {}),
  };
}

function selectorsFromMap(mapping: Record<string, string>): TnbLspServerConfig["selectors"] {
  const byLanguage = new Map<string, string[]>();
  for (const [extension, languageId] of Object.entries(mapping)) {
    const normalized = extension.startsWith(".") ? extension : `.${extension}`;
    byLanguage.set(languageId, [...(byLanguage.get(languageId) ?? []), normalized]);
  }
  return [...byLanguage].map(([languageId, extensions]) => ({ languageId, extensions }));
}

function resolveExecutable(
  command: string,
  which: (command: string) => string | null,
): string | undefined {
  if (isAbsolute(command)) return command;
  return which(command) ?? undefined;
}

function findExecutable(command: string, env: Record<string, string | undefined>): string | null {
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of (env.PATH ?? process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
