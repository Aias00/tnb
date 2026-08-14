import { relative, resolve } from "node:path";

import { defineTool } from "../core/tool";
import { currentWorkspaceRoot, type WorkspaceRootSource } from "../core/workspace-state";
import { GLOB_TOOL_PROMPT, GREP_TOOL_PROMPT } from "../constants/tool-prompts";
import { assertToolPathInsideAllowedRoots, resolveWorkspaceRoot } from "../utils/workspace-path";

type SearchToolOptions = { executable?: string };
type GrepInput = { pattern: string; path?: string; glob?: string; maxResults: number };
type GlobInput = { pattern: string; path?: string; maxResults: number };

const DEFAULT_GREP_RESULTS = 250;
const DEFAULT_GLOB_RESULTS = 100;
const GREP_MAX_CHARS = 20_000;
const GLOB_MAX_CHARS = 100_000;

export function createGrepTool(workspaceRoot: WorkspaceRootSource, options: SearchToolOptions = {}, additionalRoots: () => string[] = () => []) {
  return defineTool<GrepInput>({
    name: "grep",
    description: GREP_TOOL_PROMPT,
    inputSchema: objectSchema(
      {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "Workspace file or directory. Defaults to the workspace." },
        glob: { type: "string", description: "Optional file glob such as *.ts." },
        maxResults: {
          type: "integer",
          minimum: 0,
          description: `Maximum result lines. Defaults to ${DEFAULT_GREP_RESULTS}.`,
        },
      },
      ["pattern"],
    ),
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    validate(input) {
      const value = requireObject(input);
      return {
        pattern: requireNonEmptyString(value.pattern, "grep pattern"),
        ...optionalString(value.path, "grep path", "path"),
        ...optionalString(value.glob, "grep glob", "glob"),
        maxResults: resultLimit(value.maxResults, DEFAULT_GREP_RESULTS),
      };
    },
    async execute(input, signal) {
      const root = resolveWorkspaceRoot(currentWorkspaceRoot(workspaceRoot));
      const target = await searchTarget(root, input.path, additionalRoots());
      const glob = input.glob ? new Bun.Glob(input.glob) : undefined;
      const args = [
        "--line-number",
        "--column",
        "--with-filename",
        "--no-heading",
        "--no-require-git",
        "--color",
        "never",
        "--smart-case",
        "-e",
        input.pattern,
      ];
      args.push("--", target);

      const result = await runRipgrep(
        options.executable ?? "rg",
        args,
        root,
        input.maxResults,
        signal,
        glob
          ? (line) => {
              const match = /^(.*):\d+:\d+:/.exec(normalizeSearchLine(line));
              return match ? matchesGlob(glob, match[1] ?? "") : false;
            }
          : undefined,
        GREP_MAX_CHARS,
      );
      if (result.exitCode === 1 && result.lines.length === 0) return "No matches found";
      assertSuccessfulSearch(result);
      if (result.lines.length === 0) return "No matches found";
      return formatResult({ ...result, lines: result.lines.map(normalizeSearchLine) });
    },
  });
}

export function createGlobTool(workspaceRoot: WorkspaceRootSource, options: SearchToolOptions = {}, additionalRoots: () => string[] = () => []) {
  return defineTool<GlobInput>({
    name: "glob",
    description: GLOB_TOOL_PROMPT,
    inputSchema: objectSchema(
      {
        pattern: { type: "string", description: "File glob such as **/*.ts." },
        path: { type: "string", description: "Workspace directory. Defaults to the workspace." },
        maxResults: {
          type: "integer",
          minimum: 0,
          description: `Maximum file paths. Defaults to ${DEFAULT_GLOB_RESULTS}.`,
        },
      },
      ["pattern"],
    ),
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    validate(input) {
      const value = requireObject(input);
      return {
        pattern: requireNonEmptyString(value.pattern, "glob pattern"),
        ...optionalString(value.path, "glob path", "path"),
        maxResults: resultLimit(value.maxResults, DEFAULT_GLOB_RESULTS),
      };
    },
    async execute(input, signal) {
      const root = resolveWorkspaceRoot(currentWorkspaceRoot(workspaceRoot));
      const target = await searchTarget(root, input.path, additionalRoots());
      const glob = new Bun.Glob(input.pattern);
      const result = await runRipgrep(
        options.executable ?? "rg",
        ["--files", "--no-require-git", "--sort", "path", "--", target],
        root,
        input.maxResults,
        signal,
        (line) => matchesGlob(glob, normalizeRelativePath(line)),
        GLOB_MAX_CHARS,
      );
      assertSuccessfulSearch(result);
      if (result.lines.length === 0) return "No files found";
      return formatResult({ ...result, lines: result.lines.map(normalizeRelativePath) });
    },
  });
}

async function searchTarget(root: string, path = ".", additionalRoots: readonly string[] = []): Promise<string> {
  await assertToolPathInsideAllowedRoots(root, path, "read", additionalRoots);
  const absolute = resolve(root, path);
  const mainRelative = relative(root, absolute);
  return !mainRelative.startsWith("..") ? mainRelative || "." : absolute;
}

type SearchResult = {
  lines: string[];
  truncated: boolean;
  exitCode: number;
  stderr: string;
};

async function runRipgrep(
  executable: string,
  args: string[],
  cwd: string,
  maxResults: number,
  signal: AbortSignal,
  includeLine?: (line: string) => boolean,
  maxChars?: number,
): Promise<SearchResult> {
  signal.throwIfAborted();
  try {
    const process = Bun.spawn([executable, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
    const stderrPromise = new Response(process.stderr).text();
    const output = await readLimitedLines(
      process.stdout,
      maxResults,
      () => process.kill(),
      includeLine,
      maxChars,
    );
    const [exitCode, stderr] = await Promise.all([process.exited, stderrPromise]);
    signal.throwIfAborted();
    return { ...output, exitCode, stderr };
  } catch (error) {
    if (isMissingExecutable(error)) {
      throw new Error(`ripgrep executable was not found: ${executable}`);
    }
    throw error;
  }
}

async function readLimitedLines(
  stream: ReadableStream<Uint8Array>,
  maxResults: number,
  stop: () => void,
  includeLine: (line: string) => boolean = () => true,
  maxChars = Number.MAX_SAFE_INTEGER,
): Promise<{ lines: string[]; truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let pending = "";
  let truncated = false;
  let outputChars = 0;

  const appendLine = (line: string): void => {
    const separatorChars = lines.length > 0 ? 1 : 0;
    if (maxResults > 0 && lines.length === maxResults) {
      truncated = true;
      return;
    }
    const remainingChars = maxChars - outputChars - separatorChars;
    if (line.length > remainingChars) {
      if (remainingChars > 0) lines.push(line.slice(0, remainingChars));
      truncated = true;
      return;
    }
    lines.push(line);
    outputChars += separatorChars + line.length;
  };

  while (!truncated) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (line && includeLine(line)) {
        appendLine(line);
        if (truncated) {
          stop();
          break;
        }
      }
      newline = pending.indexOf("\n");
    }
    if (done) break;
  }

  if (!truncated && pending && includeLine(pending)) {
    appendLine(pending.replace(/\r$/, ""));
  }
  await reader.cancel();
  return { lines, truncated };
}

function assertSuccessfulSearch(result: SearchResult): void {
  if (result.truncated || result.exitCode === 0) return;
  throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`);
}

function formatResult(result: Pick<SearchResult, "lines" | "truncated">): string {
  const output = result.lines.join("\n");
  return result.truncated ? `${output}\n(Results truncated; narrow the search or raise maxResults.)` : output;
}

function normalizeRelativePath(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

function normalizeSearchLine(line: string): string {
  return line.startsWith("./") ? line.slice(2) : line;
}

function matchesGlob(glob: Bun.Glob, path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return glob.match(path) || glob.match(name);
}

function resultLimit(value: unknown, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("maxResults must be a non-negative integer");
  }
  return value as number;
}

function optionalString(
  value: unknown,
  label: string,
  key: "path" | "glob",
): { path?: string; glob?: string } {
  if (value === undefined) return {};
  return { [key]: requireNonEmptyString(value, label) };
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("tool input must be an object");
  }
  return input as Record<string, unknown>;
}

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function isMissingExecutable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "ENOENT" || error.message.includes("ENOENT");
}
