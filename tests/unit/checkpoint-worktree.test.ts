import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CheckpointManager } from "../../src/services/checkpoint/manager";
import {
  createSessionWorktree,
  inspectWorktree,
  listManagedWorktreeJobs,
  removeManagedWorktreeJob,
  removeSessionWorktree,
} from "../../src/services/worktree/manager";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("checkpoint and worktree services", () => {
  test("restores tracked, staged, and untracked state without touching ignored files", async () => {
    const root = await gitWorkspace();
    const configDir = await temporary("tnb-home-");
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "tracked.txt"), "checkpoint\n");
    await writeFile(join(root, "staged.txt"), "staged checkpoint\n");
    await writeFile(join(root, "untracked.txt"), "untracked checkpoint\n");
    await writeFile(join(root, "ignored.txt"), "ignored checkpoint\n");
    await git(root, ["add", "staged.txt"]);

    const manager = new CheckpointManager(configDir);
    const checkpoint = await manager.create(root, "before edits");
    await writeFile(join(root, "tracked.txt"), "changed\n");
    await writeFile(join(root, "staged.txt"), "changed\n");
    await writeFile(join(root, "untracked.txt"), "changed\n");
    await writeFile(join(root, "new.txt"), "remove me\n");
    await writeFile(join(root, "ignored.txt"), "ignored changed\n");

    await manager.rollback(root, checkpoint.id);

    expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("checkpoint\n");
    expect(await readFile(join(root, "staged.txt"), "utf8")).toBe("staged checkpoint\n");
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("untracked checkpoint\n");
    expect(await readFile(join(root, "ignored.txt"), "utf8")).toBe("ignored changed\n");
    expect(await Bun.file(join(root, "new.txt")).exists()).toBe(false);
    expect((await git(root, ["diff", "--cached", "--name-only"])).trim()).toBe("staged.txt");
  });

  test("creates an isolated worktree and reports changes before removal", async () => {
    const root = await gitWorkspace();
    const state = await createSessionWorktree(root, "feature/test");
    directories.push(join(root, ".tnb"));
    expect(await readFile(join(state.worktreePath, "tracked.txt"), "utf8")).toBe("base\n");
    await writeFile(join(state.worktreePath, "tracked.txt"), "changed\n");
    expect(await inspectWorktree(state)).toEqual({ changedFiles: 1, commits: 0 });
    await removeSessionWorktree(state);
    expect(await Bun.file(state.worktreePath).exists()).toBe(false);
  });

  test("lists managed worktrees and protects changes during CLI-style removal", async () => {
    const root = await gitWorkspace();
    const state = await createSessionWorktree(root, "feature/jobs");
    directories.push(join(root, ".tnb"));

    expect(await listManagedWorktreeJobs(root)).toEqual([
      expect.objectContaining({
        id: "feature+jobs",
        path: state.worktreePath,
        branch: state.worktreeBranch,
        changedFiles: 0,
        uniqueCommits: 0,
      }),
    ]);
    expect((await listManagedWorktreeJobs(state.worktreePath))[0]?.id).toBe("feature+jobs");

    await writeFile(join(state.worktreePath, "tracked.txt"), "changed\n");
    await expect(removeManagedWorktreeJob(root, "feature+jobs", { discardChanges: false }))
      .rejects.toThrow("pass --discard-changes");
    await removeManagedWorktreeJob(root, "feature+jobs", { discardChanges: true });
    expect(await listManagedWorktreeJobs(root)).toEqual([]);
  });
});

async function gitWorkspace(): Promise<string> {
  const root = await temporary("tnb-git-");
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "tnb@example.invalid"]);
  await git(root, ["config", "user.name", "tnb test"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "base"]);
  return root;
}

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout;
}
