import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { defineTool } from "../core/tool";
import { currentWorkspaceRoot, type WorkspaceRootSource } from "../core/workspace-state";
import {
  BASH_TOOL_PROMPT,
  EDIT_TOOL_PROMPT,
  READ_TOOL_PROMPT,
  WRITE_TOOL_PROMPT,
} from "../constants/tool-prompts";
import { assertToolPathInsideAllowedRoots, resolveWorkspaceRoot } from "../utils/workspace-path";
import { isImagePath, isPdfPath, readImage, readPdf } from "./read-media";

export { createGlobTool, createGrepTool } from "./search";
export { createWebFetchTool } from "./web-fetch";

export function createReadTool(
  workspaceRoot: WorkspaceRootSource,
  capabilities: { supportsVision: boolean; supportsPdf: boolean } = {
    supportsVision: true,
    supportsPdf: true,
  },
  additionalRoots: () => string[] = () => [],
) {
  return defineTool({
    name: "read",
    description: READ_TOOL_PROMPT,
    inputSchema: objectSchema(
      {
        path: {
          type: "string",
          description: "Absolute or workspace-relative path to a text file, supported image, or PDF inside the workspace.",
        },
        pages: {
          type: "string",
          description: "Optional PDF page number or inclusive range such as 1-5; maximum 20 pages.",
        },
      },
      ["path"],
    ),
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permissionRuleContent: ({ path }) => path,
    validate(input) {
      const value = requireObject(input);
      if (typeof value.path !== "string" || !value.path.trim()) {
        throw new Error("read requires a non-empty path string");
      }
      if (value.pages !== undefined && (typeof value.pages !== "string" || !value.pages.trim())) {
        throw new Error("read pages must be a non-empty string");
      }
      return {
        path: value.path,
        ...(typeof value.pages === "string" ? { pages: value.pages } : {}),
      };
    },
    async execute({ path, pages }, signal) {
      const root = resolveWorkspaceRoot(currentWorkspaceRoot(workspaceRoot));
      await assertToolPathInsideAllowedRoots(root, path, "read", additionalRoots());
      const target = resolve(root, path);
      if (isImagePath(target)) {
        if (pages !== undefined) throw new Error("read pages is only valid for PDF files");
        if (!capabilities.supportsVision) {
          throw new Error("The selected model does not support image input");
        }
        return readImage(target, path, signal);
      }
      if (isPdfPath(target)) return readPdf(target, path, pages, signal, capabilities);
      if (pages !== undefined) throw new Error("read pages is only valid for PDF files");
      return readFile(target, { encoding: "utf8", signal });
    },
  });
}

export function createWriteTool(workspaceRoot: WorkspaceRootSource, additionalRoots: () => string[] = () => []) {
  return defineTool({
    name: "write",
    description: WRITE_TOOL_PROMPT,
    inputSchema: objectSchema(
      {
        path: {
          type: "string",
          description: "Absolute or workspace-relative destination path inside the workspace.",
        },
        content: {
          type: "string",
          description: "The complete UTF-8 content that will replace the destination file.",
        },
      },
      ["path", "content"],
    ),
    access: "write",
    permissionRuleContent: ({ path }) => path,
    validate(input) {
      const value = requireObject(input);
      if (typeof value.path !== "string" || !value.path.trim() || typeof value.content !== "string") {
        throw new Error("write requires path and content strings");
      }
      return { path: value.path, content: value.content };
    },
    async execute({ path, content }, signal) {
      const root = resolveWorkspaceRoot(currentWorkspaceRoot(workspaceRoot));
      await assertToolPathInsideAllowedRoots(root, path, "write", additionalRoots());
      const target = resolve(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { encoding: "utf8", signal });
      return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`;
    },
  });
}

export function createEditTool(workspaceRoot: WorkspaceRootSource, additionalRoots: () => string[] = () => []) {
  return defineTool({
    name: "edit",
    description: EDIT_TOOL_PROMPT,
    inputSchema: objectSchema(
      {
        path: {
          type: "string",
          description: "Absolute or workspace-relative path to the existing file.",
        },
        oldText: {
          type: "string",
          description: "The exact, unique text to replace, including its original whitespace.",
        },
        newText: {
          type: "string",
          description: "Replacement text, including the intended whitespace and formatting.",
        },
        replaceAll: {
          type: "boolean",
          description: "Replace every exact occurrence of oldText instead of requiring one unique match.",
        },
      },
      ["path", "oldText", "newText"],
    ),
    access: "write",
    permissionRuleContent: ({ path }) => path,
    validate(input) {
      const value = requireObject(input);
      if (
        typeof value.path !== "string" ||
        !value.path.trim() ||
        typeof value.oldText !== "string" ||
        !value.oldText ||
        typeof value.newText !== "string" ||
        (value.replaceAll !== undefined && typeof value.replaceAll !== "boolean")
      ) {
        throw new Error("edit requires path, oldText, and newText strings");
      }
      return { path: value.path, oldText: value.oldText, newText: value.newText, replaceAll: value.replaceAll === true };
    },
    async execute({ path, oldText, newText, replaceAll }, signal) {
      const root = resolveWorkspaceRoot(currentWorkspaceRoot(workspaceRoot));
      await assertToolPathInsideAllowedRoots(root, path, "write", additionalRoots());
      const target = resolve(root, path);
      const content = await readFile(target, { encoding: "utf8", signal });
      const first = content.indexOf(oldText);
      if (first < 0) throw new Error("edit target text was not found");
      const second = content.indexOf(oldText, first + oldText.length);
      if (!replaceAll && second >= 0) {
        throw new Error("edit target text is not unique");
      }
      const matches = replaceAll ? countOccurrences(content, oldText) : 1;
      const updated = replaceAll
        ? content.split(oldText).join(newText)
        : `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
      await writeFile(target, updated, {
        encoding: "utf8",
        signal,
      });
      return replaceAll ? `Edited ${path}: replaced ${matches} occurrences` : `Edited ${path}`;
    },
  });
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) >= 0) {
    count += 1;
    offset += search.length;
  }
  return count;
}

export function createBashTool(workspaceRoot: string) {
  const root = resolveWorkspaceRoot(workspaceRoot);
  return defineTool({
    name: "bash",
    description: BASH_TOOL_PROMPT,
    inputSchema: objectSchema(
      {
        command: {
          type: "string",
          description: "A shell command executed by /bin/sh with the workspace as its working directory.",
        },
      },
      ["command"],
    ),
    access: "execute",
    permissionRuleContent: ({ command }) => command,
    validate(input) {
      const value = requireObject(input);
      if (typeof value.command !== "string" || !value.command.trim()) {
        throw new Error("bash requires a non-empty command string");
      }
      return { command: value.command };
    },
    async execute({ command }, signal) {
      const process = Bun.spawn(["/bin/sh", "-lc", command], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        signal,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      const output = [stdout, stderr].filter(Boolean).join("");
      if (exitCode !== 0) throw new Error(output || `Command exited with code ${exitCode}`);
      return output || "Command completed successfully";
    },
  });
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
