import { mkdir, lstat, realpath, open } from "node:fs/promises";
import { join } from "node:path";
import { lock, check } from "../../utils/lockfile";
import { digestJson } from "./json";

/** Shared by durable workers and foreground invocations, even with different TNB_HOME values. */
async function workspaceLockTarget(workspace: string): Promise<string> {
  const canonical = await realpath(workspace);
  const directory = join("/tmp", `tnb-workspace-${process.getuid?.() ?? "local"}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new Error("Unsafe workspace lock directory");
  const target = join(directory, digestJson(canonical));
  const file = await open(target, "a", 0o600); await file.close();
  return target;
}
export async function acquireWorkspace(workspace: string): Promise<() => Promise<void>> {
  return lock(await workspaceLockTarget(workspace), { realpath: true, stale: 5000, update: 1000, retries: 0 });
}
export async function workspaceIsLocked(workspace: string): Promise<boolean> {
  return check(await workspaceLockTarget(workspace), { realpath: true, stale: 5000 });
}
