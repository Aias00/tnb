import { mkdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type { WorktreeSessionState } from "../../core/workspace-state";
import { gitRoot, runGit } from "../git/command";

const NAME_SEGMENT = /^[A-Za-z0-9._-]+$/;
const WORKTREE_BRANCH_PREFIX = "tnb-worktree-";

export type ManagedWorktreeJob = {
  id: string;
  path: string;
  branch: string;
  head: string;
  changedFiles: number;
  uniqueCommits: number;
  locked: boolean;
};

export function validateWorktreeName(name: string): string {
  const value = name.trim();
  if (!value || value.length > 64) throw new Error("Worktree name must contain 1 to 64 characters");
  for (const segment of value.split("/")) {
    if (segment === "." || segment === ".." || !NAME_SEGMENT.test(segment)) {
      throw new Error("Worktree name segments may contain only letters, digits, dots, underscores, and dashes");
    }
  }
  return value;
}

export async function createSessionWorktree(cwd: string, name: string): Promise<WorktreeSessionState> {
  const worktreeName = validateWorktreeName(name);
  const root = await gitCommonWorktreeRoot(cwd);
  const flattened = worktreeName.replaceAll("/", "+");
  const worktreePath = join(root, ".tnb", "worktrees", flattened);
  const worktreeBranch = `${WORKTREE_BRANCH_PREFIX}${flattened}`;
  const originalHead = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  await mkdir(join(root, ".tnb", "worktrees"), { recursive: true });

  const registered = await runGit(root, ["worktree", "list", "--porcelain"]);
  if (!registered.stdout.split("\n").some((line) => line === `worktree ${worktreePath}`)) {
    await runGit(root, ["worktree", "add", "-B", worktreeBranch, worktreePath, "HEAD"]);
  }
  return { originalCwd: cwd, worktreePath, worktreeName, worktreeBranch, originalHead };
}

export async function inspectWorktree(session: WorktreeSessionState): Promise<{
  changedFiles: number;
  commits: number;
}> {
  const status = await runGit(session.worktreePath, ["status", "--porcelain"]);
  const revs = await runGit(session.worktreePath, [
    "rev-list",
    "--count",
    `${session.originalHead}..HEAD`,
  ]);
  return {
    changedFiles: status.stdout.split("\n").filter((line) => line.trim()).length,
    commits: Number.parseInt(revs.stdout.trim(), 10) || 0,
  };
}

export async function removeSessionWorktree(session: WorktreeSessionState): Promise<void> {
  const root = await gitRoot(session.originalCwd);
  await runGit(root, ["worktree", "remove", "--force", session.worktreePath]);
  await runGit(root, ["branch", "-D", session.worktreeBranch], { allowFailure: true });
}

export async function listManagedWorktreeJobs(cwd: string): Promise<ManagedWorktreeJob[]> {
  const root = await gitCommonWorktreeRoot(cwd);
  const managedDirectory = resolve(root, ".tnb", "worktrees");
  const records = parseWorktreeList((await runGit(root, ["worktree", "list", "--porcelain"])).stdout);
  const jobs = await Promise.all(records.flatMap((record) => {
    if (!record.path || !record.branch?.startsWith(`refs/heads/${WORKTREE_BRANCH_PREFIX}`)) return [];
    const path = resolve(record.path);
    if (!isInside(managedDirectory, path)) return [];
    return [inspectManagedRecord(root, {
      id: basename(path),
      path,
      branch: record.branch.slice("refs/heads/".length),
      head: record.head ?? "",
      locked: record.locked,
    })];
  }));
  return jobs.sort((left, right) => left.id.localeCompare(right.id));
}

export async function removeManagedWorktreeJob(
  cwd: string,
  id: string,
  options: { discardChanges: boolean },
): Promise<ManagedWorktreeJob> {
  const normalizedId = validateJobId(id);
  const jobs = await listManagedWorktreeJobs(cwd);
  const job = jobs.find((candidate) => candidate.id === normalizedId);
  if (!job) throw new Error(`No managed worktree job found with ID: ${normalizedId}`);
  if ((job.changedFiles > 0 || job.uniqueCommits > 0) && !options.discardChanges) {
    throw new Error(
      `Worktree job ${job.id} contains ${job.changedFiles} changed files and ${job.uniqueCommits} unique commits; pass --discard-changes only after confirming they may be deleted`,
    );
  }
  const root = await gitCommonWorktreeRoot(cwd);
  await runGit(root, ["worktree", "remove", "--force", job.path]);
  await runGit(root, ["branch", "-D", job.branch], { allowFailure: true });
  return job;
}

function parseWorktreeList(output: string): Array<{
  path?: string;
  head?: string;
  branch?: string;
  locked: boolean;
}> {
  return output.trim().split(/\n\s*\n/).filter(Boolean).map((section) => {
    const record: { path?: string; head?: string; branch?: string; locked: boolean } = { locked: false };
    for (const line of section.split("\n")) {
      const separator = line.indexOf(" ");
      const key = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? "" : line.slice(separator + 1);
      if (key === "worktree") record.path = value;
      else if (key === "HEAD") record.head = value;
      else if (key === "branch") record.branch = value;
      else if (key === "locked") record.locked = true;
    }
    return record;
  });
}

async function inspectManagedRecord(
  root: string,
  record: Omit<ManagedWorktreeJob, "changedFiles" | "uniqueCommits">,
): Promise<ManagedWorktreeJob> {
  const [status, commits] = await Promise.all([
    runGit(record.path, ["status", "--porcelain"]),
    runGit(root, ["rev-list", "--count", `HEAD..${record.branch}`]),
  ]);
  return {
    ...record,
    changedFiles: status.stdout.split("\n").filter((line) => line.trim()).length,
    uniqueCommits: Number.parseInt(commits.stdout.trim(), 10) || 0,
  };
}

function validateJobId(id: string): string {
  const value = id.trim();
  if (!/^[A-Za-z0-9._+-]{1,64}$/.test(value) || value === "." || value === "..") {
    throw new Error("Worktree job ID must contain 1 to 64 letters, digits, dots, underscores, dashes, or plus signs");
  }
  return value;
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

async function gitCommonWorktreeRoot(cwd: string): Promise<string> {
  const commonDirectory = (await runGit(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])).stdout.trim();
  if (basename(commonDirectory) !== ".git") {
    throw new Error("Managed worktree jobs require a non-bare Git repository");
  }
  return dirname(commonDirectory);
}
