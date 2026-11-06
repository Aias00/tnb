import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../src/services/git/command";
import { CheckpointManager } from "../../src/services/checkpoint/manager";
import { previewRestore, restoreCheckpoint } from "../../src/services/checkpoint/restore";
import { SessionStore } from "../../src/services/session/storage";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-restore-")); roots.push(root);
  const configDir = await mkdtemp(join(tmpdir(), "tnb-restore-home-")); roots.push(configDir);
  await runGit(root, ["init", "-q"]); await writeFile(join(root, "file.txt"), "before\n"); await runGit(root, ["add", "."]);
  await runGit(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  await runGit(root, ["config", "user.name", "Test"]); await runGit(root, ["config", "user.email", "test@example.invalid"]);
  const session = new SessionStore({ configDir, cwd: root, sessionId: "restore-session" });
  await session.append([{ role: "user", content: [{ type: "text", text: "first" }] }, { role: "assistant", content: [{ type: "text", text: "answer" }] }]);
  const checkpoint = await new CheckpointManager(configDir).create(root, "before", { sessionId: session.sessionId, sessionCwd: root, messageCount: 2 });
  await session.append([{ role: "user", content: [{ type: "text", text: "second" }] }, { role: "assistant", content: [{ type: "text", text: "later" }] }]);
  await writeFile(join(root, "file.txt"), "after\n"); await writeFile(join(root, "new.txt"), "untracked\n");
  return { options: { configDir, cwd: root, sessionId: session.sessionId, checkpointId: checkpoint.id }, session };
}

test("restore preview is read-only and detects newly changed untracked content", async () => {
  const { options, session } = await fixture(); const preview = await previewRestore(options);
  expect(preview.messagesRemoved).toBe(2); expect(preview.untrackedFiles).toContain("new.txt");
  expect(await readFile(join(options.cwd, "file.txt"), "utf8")).toBe("after\n");
  expect(await session.read()).toHaveLength(4);
  await writeFile(join(options.cwd, "new.txt"), "changed later\n");
  await expect(restoreCheckpoint({ ...options, scope: "both", expected: preview.expected })).rejects.toThrow("changed after preview");
  expect(await readFile(join(options.cwd, "file.txt"), "utf8")).toBe("after\n"); expect(await session.read()).toHaveLength(4);
});

for (const scope of ["files", "conversation", "both"] as const) test(`restore respects ${scope} scope`, async () => {
  const { options, session } = await fixture(); const preview = await previewRestore(options);
  const result = await restoreCheckpoint({ ...options, scope, expected: preview.expected });
  expect(result.filesRestored).toBe(scope !== "conversation");
  expect(await readFile(join(options.cwd, "file.txt"), "utf8")).toBe(scope === "conversation" ? "after\n" : "before\n");
  expect(await session.read()).toHaveLength(scope === "files" ? 4 : 2);
});

test("conversation changes and active ownership invalidate or block restore before file effects", async () => {
  const { options, session } = await fixture(); const preview = await previewRestore(options);
  await session.append([{ role: "user", content: [{ type: "text", text: "new user request" }] }]);
  await expect(restoreCheckpoint({ ...options, scope: "both", expected: preview.expected })).rejects.toThrow("changed after preview");
  const latest = await previewRestore(options);
  const release = await session.acquireRun();
  try { await expect(restoreCheckpoint({ ...options, scope: "both", expected: latest.expected })).rejects.toThrow("active runner"); }
  finally { await release(); }
  expect(await readFile(join(options.cwd, "file.txt"), "utf8")).toBe("after\n");
});
