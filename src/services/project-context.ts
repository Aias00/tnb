import { readFile, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

export type LoadProjectInstructionsOptions = { stopAt?: string };

export type ProjectInstructionFile = {
  filePath: string;
  content: string;
  memoryType: "Project" | "Local";
};

export async function loadProjectInstructions(
  cwd: string,
  options: LoadProjectInstructionsOptions = {},
): Promise<string> {
  const files = await loadProjectInstructionFiles(cwd, options);
  return files
    .map(({ filePath, content }) => `## Instructions from ${filePath}\n\n${content}`)
    .join("\n\n");
}

export async function loadProjectInstructionFiles(
  cwd: string,
  options: LoadProjectInstructionsOptions = {},
): Promise<ProjectInstructionFile[]> {
  const workspace = resolve(cwd);
  const directories = hierarchy(
    workspace,
    options.stopAt ? resolve(options.stopAt) : parse(workspace).root,
  );
  const candidates = directories.flatMap((directory) => [
    join(directory, "AGENTS.md"),
    join(directory, "CLAUDE.md"),
    ...(directory === workspace
      ? [join(directory, ".tnb", "instructions.md")]
      : []),
  ]);
  const files: ProjectInstructionFile[] = [];
  for (const path of candidates) {
    const content = await readOptionalFile(path);
    if (!content?.trim()) continue;
    files.push({
      filePath: path,
      content: content.trim(),
      memoryType: path.endsWith(join(".tnb", "instructions.md")) ? "Local" : "Project",
    });
  }
  return files;
}

export async function isInsideGitRepository(cwd: string): Promise<boolean> {
  let directory = resolve(cwd);
  while (true) {
    try {
      await stat(join(directory, ".git"));
      return true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

function hierarchy(start: string, stopAt: string): string[] {
  const directories: string[] = [];
  let directory = start;
  while (true) {
    directories.unshift(directory);
    if (directory === stopAt) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return directories;
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
