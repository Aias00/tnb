import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { CheckpointManager } from "./manager";
import { gitRoot, runGit } from "../git/command";
import { SessionStore } from "../session/storage";
import { acquireWorkspace } from "../runtime/workspace";
import { digestJson } from "../runtime/json";

export type RestoreScope = "both" | "files" | "conversation";
type RestoreOptions = { configDir: string; cwd: string; sessionId: string; checkpointId: string };

/** Read-only preview; include untracked content because restore deletes untracked paths. */
export async function previewRestore(options: RestoreOptions) {
  const root = await gitRoot(options.cwd), manager = new CheckpointManager(options.configDir);
  const checkpoint = await manager.get(root, options.checkpointId);
  const [head, status, diff, untracked] = await Promise.all([
    runGit(root, ["rev-parse", "HEAD"]),
    runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    runGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--binary", checkpoint.snapshotCommit, "--"]),
    runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const untrackedFiles = untracked.stdout.split("\0").filter(Boolean);
  if (untrackedFiles.length > 10000) throw new Error("Too many untracked files to safely preview restore");
  const hashes: Array<[string, string]> = [];
  let bytes = 0;
  for (const file of untrackedFiles) {
    const path = join(root, file), info = await lstat(path);
    if (info.isSymbolicLink()) hashes.push([file, `link:${await readlink(path)}`]);
    else {
      if (!info.isFile() || (bytes += info.size) > 256 * 1024 * 1024 || info.size > 16 * 1024 * 1024) throw new Error("Untracked file exceeds safe restore preview limits");
      hashes.push([file, createHash("sha256").update(await readFile(path)).digest("hex")]);
    }
  }
  let conversation: Awaited<ReturnType<SessionStore["readState"]>> | undefined;
  const canRestoreConversation = checkpoint.sessionId === options.sessionId && checkpoint.messageCount !== undefined;
  if (canRestoreConversation) {
    conversation = await new SessionStore({ configDir: options.configDir, cwd: checkpoint.sessionCwd ?? options.cwd, sessionId: options.sessionId }).readState();
    if (checkpoint.messageCount! > conversation.messages.length) throw new Error("Checkpoint conversation boundary is newer than the current transcript");
  }
  const expected = digestJson({ checkpoint, head: head.stdout, status: status.stdout, diff: diff.stdout, untracked: hashes, conversation: conversation?.messages });
  const stats = await runGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--stat", checkpoint.snapshotCommit, "--"]);
  return { checkpoint, root, expected, headChanged: head.stdout.trim() !== checkpoint.head, untrackedFiles,
    fileSummary: stats.stdout.trim() || "No tracked file content changes.", canRestoreConversation,
    messagesRemoved: conversation ? conversation.messages.length - checkpoint.messageCount! : undefined };
}

/** Caller authorization is an explicit preview-bound confirmation, not a model tool. */
export async function restoreCheckpoint(options: RestoreOptions & { scope: RestoreScope; expected: string; force?: boolean }) {
  if (!["both", "files", "conversation"].includes(options.scope) || !/^[a-f0-9]{64}$/.test(options.expected)) throw new Error("Restore requires a valid scope and preview confirmation");
  const releaseWorkspace = await acquireWorkspace(await gitRoot(options.cwd));
  let releaseSession: (() => Promise<void>) | undefined;
  let filesRestored = false, filesStarted = false;
  try {
    const manager = new CheckpointManager(options.configDir);
    const root = await gitRoot(options.cwd);
    const home = await realpath(options.configDir);
    if (options.scope !== "conversation" && (home === root || home.startsWith(`${root}${sep}`))) throw new Error("File restore cannot run with TNB_HOME inside the Git workspace; move control state outside the repository first.");
    const checkpoint = await manager.get(root, options.checkpointId);
    const session = new SessionStore({ configDir: options.configDir, cwd: checkpoint.sessionCwd ?? options.cwd, sessionId: options.sessionId });
    if (options.scope !== "files") releaseSession = await session.acquireRun();
    const preview = await previewRestore(options);
    if (preview.expected !== options.expected) throw new Error("Workspace or conversation changed after preview. Open /rollback again; nothing was restored.");
    if (options.scope !== "files" && !preview.canRestoreConversation) throw new Error("This checkpoint has no conversation boundary for the active session");
    if (options.scope !== "conversation") {
      filesStarted = true;
      await manager.rollback(options.cwd, options.checkpointId, options.force);
      filesRestored = true;
    }
    if (options.scope !== "files") {
      const state = await session.readState();
      const messages = state.messages.slice(0, checkpoint.messageCount!);
      await session.appendRewindBoundary(messages);
      return { checkpoint, filesRestored, conversationRestored: true, messages, usage: state.usage };
    }
    return { checkpoint, filesRestored, conversationRestored: false };
  } catch (error) {
    if (filesStarted && !filesRestored) throw new Error(`Workspace restore failed after it began; some files may have changed. Check Git status before retrying: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    if (filesRestored) throw new Error(`Workspace files were restored, but conversation restore failed. Do not blindly retry: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    throw error;
  } finally { try { await releaseSession?.(); } finally { await releaseWorkspace(); } }
}
