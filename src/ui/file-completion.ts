import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export async function completeWorkspaceFiles(input: string, cwd: string, signal: AbortSignal): Promise<string[]> {
  const token = completionToken(input);
  if (!token) return [];
  const prefix = token.value.replace(/^@/, "");
  if (prefix.startsWith("/") || prefix.includes("..")) return [];
  const separator = prefix.lastIndexOf("/");
  const directoryPart = separator < 0 ? "" : prefix.slice(0, separator + 1);
  const basenamePrefix = separator < 0 ? prefix : prefix.slice(separator + 1);
  const directory = resolve(cwd, directoryPart || ".");
  if (directory !== resolve(cwd) && !directory.startsWith(`${resolve(cwd)}${sep}`)) return [];
  if (signal.aborted) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.name.startsWith(".") && entry.name.toLocaleLowerCase().startsWith(basenamePrefix.toLocaleLowerCase()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 40)
    .map((entry) => {
      const path = relative(cwd, join(directory, entry.name)).split(sep).join("/") + (entry.isDirectory() ? "/" : "");
      const replacement = `${token.at ? "@" : ""}${path}`;
      return `${input.slice(0, token.start)}${replacement}${input.slice(token.end)}`;
    });
}

function completionToken(input: string): { start: number; end: number; value: string; at: boolean } | undefined {
  const match = input.match(/(?:^|\s)(@?[^\s]*)$/);
  if (!match) return undefined;
  const value = match[1] ?? "";
  const at = value.startsWith("@");
  const pathLike = at || value.includes("/") || value.startsWith(".");
  if (!pathLike) return undefined;
  return { start: input.length - value.length, end: input.length, value, at };
}
