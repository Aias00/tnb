import { readdir, realpath } from "node:fs/promises";
import { workspaceFileIndex, rankWorkspaceFiles } from "../services/workspace/file-index";
import { join, relative, resolve, sep } from "node:path";

export type WorkspaceCompletionToken = { start: number; end: number; value: string; at: boolean };

export function workspaceCompletionToken(input: string, cursor = input.length): WorkspaceCompletionToken | undefined {
  cursor = Math.max(0, Math.min(input.length, cursor));
  // Quoted @ references support filenames containing spaces.
  const quoted = /(?:^|\s)(@?"[^"\n]*)$/.exec(input.slice(0, cursor));
  const match = quoted ?? /(?:^|\s)(@?[^\s"]*)$/.exec(input.slice(0, cursor));
  if (!match) return undefined;
  const typed = match[1] ?? "";
  const at = typed.startsWith("@");
  if (!at && !typed.includes("/") && !typed.startsWith(".")) return undefined;
  const start = cursor - typed.length;
  const rest = input.slice(cursor);
  const tail = quoted ? /^[^"\n]*(?:")?/.exec(rest)?.[0] ?? "" : /^[^\s]*/.exec(rest)?.[0] ?? "";
  return { start, end: cursor + tail.length, value: typed.replace(/^@/, "").replace(/^"/, ""), at };
}

export function completionLabel(original: string, candidate: string, cursor = original.length): string {
  const token = workspaceCompletionToken(original, cursor);
  return token ? candidate.slice(token.start, candidate.length - (original.length - token.end)) : candidate;
}

export function completionCursor(original: string, candidate: string, cursor = original.length): number {
  const token = workspaceCompletionToken(original, cursor);
  return token ? candidate.length - (original.length - token.end) : candidate.length;
}

export async function completeWorkspaceFiles(input: string, cwd: string, signal: AbortSignal, cursor = input.length): Promise<string[]> {
  const token = workspaceCompletionToken(input, cursor);
  if (!token || signal.aborted) return [];
  const prefix = token.value;
  if (prefix.startsWith("/") || prefix.split("/").some(part => part === ".." || part === ".git")) return [];
  const separator = prefix.lastIndexOf("/");
  const directoryPart = separator < 0 ? "" : prefix.slice(0, separator + 1);
  const namePrefix = separator < 0 ? prefix : prefix.slice(separator + 1);
  const root = await realpath(cwd);
  let directory: string;
  try { directory = await realpath(resolve(root, directoryPart || ".")); } catch { return []; }
  if (directory !== root && !directory.startsWith(`${root}${sep}`)) return [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const paths = entries
    .filter(entry => (!entry.name.startsWith(".") || namePrefix.startsWith(".")) && entry.name !== ".git" && !/[\r\n\x00"]/.test(entry.name) && !entry.isSymbolicLink() && entry.name.toLocaleLowerCase().startsWith(namePrefix.toLocaleLowerCase()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map(entry => relative(root, join(directory, entry.name)).split(sep).join("/") + (entry.isDirectory() ? "/" : ""));
  if (token.at && separator < 0 && namePrefix) {
    const query = namePrefix.toLocaleLowerCase();
    const files = await workspaceFileIndex.files(root, signal);
    const ranked = rankWorkspaceFiles([...new Set([...paths, ...files])], query, workspaceFileIndex.recent(root));
    paths.splice(0, paths.length, ...ranked);
  }
  if (signal.aborted) return [];
  return [...new Set(paths)].slice(0, 40).map(path => {
    const quoted = /\s/.test(path) ? `"${path}"` : path;
    return `${input.slice(0, token.start)}${token.at ? "@" : ""}${quoted}${input.slice(token.end)}`;
  });
}


export function rememberWorkspaceCompletion(cwd: string, original: string, candidate: string, cursor: number) {
  const token = workspaceCompletionToken(original, cursor); if (!token) return;
  const path = completionLabel(original, candidate, cursor).replace(/^@/, "").replace(/^"|"$/g, "");
  if (!path.endsWith("/")) workspaceFileIndex.remember(resolve(cwd), path);
}
