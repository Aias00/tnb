import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

import {
  frontmatterStringList,
  parseFrontmatterFields,
} from "../skills/loader";

export type CommandSource = "user" | "project" | "compat-project" | "plugin";

export type LoadedCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  allowedTools?: string[];
  prompt: string;
  filePath: string;
  source: CommandSource;
};

export async function loadCommands(
  sources: Array<{ directory: string; source: CommandSource }>,
): Promise<{ commands: LoadedCommand[]; errors: Array<{ path: string; error: string }> }> {
  const commands = new Map<string, LoadedCommand>();
  const errors: Array<{ path: string; error: string }> = [];
  for (const source of sources) {
    const files = await markdownFiles(source.directory);
    for (const filePath of files) {
      try {
        const command = parseCommandMarkdown(
          await readFile(filePath, "utf8"),
          filePath,
          commandName(source.directory, filePath),
          source.source,
        );
        commands.set(command.name.toLowerCase(), command);
      } catch (error) {
        errors.push({
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { commands: [...commands.values()], errors };
}

export function expandCommandInput(
  input: string,
  commands: readonly LoadedCommand[],
): { prompt: string; command: LoadedCommand } | undefined {
  const match = input.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  const command = commands.find((candidate) => candidate.name.toLowerCase() === match[1]!.toLowerCase());
  if (!command) return undefined;
  const argument = match[2]?.trim() ?? "";
  const positional = splitArguments(argument);
  let prompt = command.prompt.replaceAll("$ARGUMENTS", argument);
  for (let index = 9; index >= 1; index -= 1) {
    prompt = prompt.replaceAll(`$${index}`, positional[index - 1] ?? "");
  }
  return { prompt, command };
}

function parseCommandMarkdown(
  markdown: string,
  filePath: string,
  name: string,
  source: CommandSource,
): LoadedCommand {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  const fields = match ? parseFrontmatterFields(match[1] ?? "", filePath) : {};
  const prompt = (match ? markdown.slice(match[0].length) : markdown).trim();
  if (!prompt) throw new Error(`Command prompt is empty: ${filePath}`);
  const description = typeof fields.description === "string" && fields.description.trim()
    ? fields.description.trim()
    : firstDescription(prompt);
  const argumentHint = typeof fields["argument-hint"] === "string"
    ? fields["argument-hint"].trim()
    : undefined;
  const allowedTools = frontmatterStringList(fields["allowed-tools"], "allowed-tools", filePath);
  return {
    name,
    description,
    ...(argumentHint ? { argumentHint } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    prompt,
    filePath,
    source,
  };
}

async function markdownFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") files.push(path);
  }
  return files;
}

function commandName(root: string, filePath: string): string {
  return relative(root, filePath).slice(0, -extname(filePath).length).split(sep).join(":");
}

function firstDescription(prompt: string): string {
  const line = prompt.split(/\r?\n/).find((candidate) => candidate.trim())!.trim();
  return line.replace(/^#+\s*/, "").slice(0, 120);
}

function splitArguments(value: string): string[] {
  return [...value.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
