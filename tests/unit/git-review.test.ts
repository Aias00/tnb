import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../src/services/git/command";
import { loadWorkingTreeReview, parseGitStatus } from "../../src/services/git/review";

async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), "tnb-review-"));
  await runGit(cwd, ["init", "-q"]);
  return cwd;
}

test("status parsing preserves rename names and embedded spaces", () => {
  expect(parseGitStatus("R  new name.ts\0old name.ts\0 M other.ts\0")).toEqual([
    { path: "new name.ts", previousPath: "old name.ts", status: "R " },
    { path: "other.ts", status: " M" },
  ]);
});

test("review includes staged, unstaged, renamed, deleted and untracked files without changing Git", async () => {
  const cwd = await repository();
  try {
    for (const name of ["edit.ts", "rename.ts", "delete.ts"]) await writeFile(join(cwd, name), "original\n");
    await runGit(cwd, ["add", "."]);
    await runGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
    await writeFile(join(cwd, "edit.ts"), "staged\n"); await runGit(cwd, ["add", "edit.ts"]);
    await writeFile(join(cwd, "edit.ts"), "staged\nunstaged\n");
    await runGit(cwd, ["mv", "rename.ts", "renamed file.ts"]);
    await rm(join(cwd, "delete.ts"));
    await writeFile(join(cwd, "new file.ts"), "new content\n");
    await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
    const before = await runGit(cwd, ["status", "--porcelain=v1", "-z"]);
    const review = await loadWorkingTreeReview(cwd);
    expect(review.total).toBe(5);
    expect(review.files.find(file => file.path === "edit.ts")?.patch).toContain("+unstaged");
    expect(review.files.find(file => file.path === "delete.ts")?.removed).toBe(1);
    expect(review.files.find(file => file.path === "renamed file.ts")?.previousPath).toBe("rename.ts");
    expect(review.files.find(file => file.path === "new file.ts")?.added).toBe(1);
    expect(review.files.find(file => file.path === "binary.bin")?.binary).toBe(true);
    expect((await runGit(cwd, ["status", "--porcelain=v1", "-z"])).stdout).toBe(before.stdout);
    expect((await loadWorkingTreeReview(cwd, "new file.ts")).files).toHaveLength(1);
    await expect(loadWorkingTreeReview(cwd, "../../outside")).rejects.toThrow("No current change");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("review works before the first commit and does not follow untracked symlinks", async () => {
  const cwd = await repository();
  const secret = join(tmpdir(), `tnb-review-secret-${Date.now()}.txt`);
  try {
    await writeFile(join(cwd, "first.ts"), "first\n");
    await runGit(cwd, ["add", "first.ts"]);
    await writeFile(secret, "SECRET_OUTSIDE_WORKSPACE");
    await symlink(secret, join(cwd, "external"));
    const review = await loadWorkingTreeReview(cwd);
    expect(review.files.find(file => file.path === "first.ts")?.patch).toContain("+first");
    expect(review.files.find(file => file.path === "external")?.patch).not.toContain("SECRET_OUTSIDE_WORKSPACE");
  } finally { await rm(cwd, { recursive: true, force: true }); await rm(secret, { force: true }); }
});
