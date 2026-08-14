import { realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function resolveWorkspaceRoot(workspaceRoot: string): string {
  return realpathSync(resolve(workspaceRoot));
}

export function assertInsideWorkspace(
  workspaceRoot: string,
  target: string,
  operation: "read" | "write",
): void {
  const pathFromWorkspace = relative(workspaceRoot, target);
  if (
    pathFromWorkspace === ".." ||
    pathFromWorkspace.startsWith(`..${sep}`) ||
    isAbsolute(pathFromWorkspace)
  ) {
    throw new Error(`Cannot ${operation} outside the workspace: ${target}`);
  }
}

export async function assertToolPathInsideWorkspace(
  workspaceRoot: string,
  path: string,
  operation: "read" | "write",
): Promise<void> {
  const root = resolveWorkspaceRoot(workspaceRoot);
  const candidate = resolve(root, path);
  assertInsideWorkspace(root, candidate, operation);

  if (operation === "read") {
    assertInsideWorkspace(root, await realpath(candidate), operation);
    return;
  }

  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      throw new Error(`Cannot write through a symbolic link: ${path}`);
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  let existingParent = dirname(candidate);
  while (true) {
    try {
      assertInsideWorkspace(root, await realpath(existingParent), operation);
      return;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      const parent = dirname(existingParent);
      if (parent === existingParent) throw error;
      existingParent = parent;
    }
  }
}

export async function assertToolPathInsideAllowedRoots(
  workspaceRoot: string,
  path: string,
  operation: "read" | "write",
  additionalRoots: readonly string[],
): Promise<void> {
  const candidate = await canonicalCandidate(resolve(workspaceRoot, path), operation);
  const roots = [workspaceRoot, ...additionalRoots].map(resolveWorkspaceRoot);
  const matchingRoot = roots.find((root) => isInside(root, candidate));
  if (!matchingRoot) throw new Error(`Cannot ${operation} outside the workspace or approved roots: ${candidate}`);
  await assertToolPathInsideWorkspace(matchingRoot, candidate, operation);
}

async function canonicalCandidate(candidate: string, operation: "read" | "write"): Promise<string> {
  if (operation === "read") return realpath(candidate);
  try {
    if ((await lstat(candidate)).isSymbolicLink()) {
      throw new Error(`Cannot write through a symbolic link: ${candidate}`);
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  let existing = candidate;
  while (true) {
    try {
      const canonicalParent = await realpath(existing);
      return resolve(canonicalParent, relative(existing, candidate));
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
