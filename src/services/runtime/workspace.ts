import { mkdir, lstat, realpath, open } from "node:fs/promises";
import { join } from "node:path";
import { lock, check } from "../../utils/lockfile";
import { digestJson } from "./json";
import { randomUUID } from "node:crypto";
import { openCoordinator, cleanDeadLeases, pathsOverlap, processBirth } from "../usage/coordinator";

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
export async function acquireWorkspace(workspace: string, owner: string = randomUUID()): Promise<() => Promise<void>> {
  const canonical = await realpath(workspace); const target = await workspaceLockTarget(workspace);
  const db = openCoordinator(); const id = randomUUID();
  try {
    db.transaction(() => {
      cleanDeadLeases(db);
      const entries = db.query("SELECT path,owner FROM workspaces").all() as Array<{ path: string; owner: string | null }>;
      if (entries.some((entry) => entry.owner !== owner && pathsOverlap(canonical, entry.path))) throw Object.assign(new Error("Workspace lock is already being held by an overlapping TNB invocation"), { code: "ELOCKED" });
      db.query("INSERT INTO workspaces(id,path,pid,owner,born) VALUES(?,?,?,?,?)").run(id, canonical, process.pid, owner, processBirth(process.pid));
    }).immediate();
    const release = await lock(target, { realpath: true, stale: 5000, update: 1000, retries: 0 });
    return async () => { try { await release(); } finally { try { db.query("DELETE FROM workspaces WHERE id=?").run(id); } finally { db.close(); } } };
  } catch (error) { try { db.query("DELETE FROM workspaces WHERE id=?").run(id); } finally { db.close(); } throw error; }
}
export async function workspaceIsLocked(workspace: string): Promise<boolean> {
  const canonical = await realpath(workspace); const db = openCoordinator();
  try {
    const locked = db.transaction(() => {
      cleanDeadLeases(db);
      return (db.query("SELECT path FROM workspaces").all() as Array<{ path: string }>).some((entry) => pathsOverlap(canonical, entry.path));
    }).immediate();
    return locked || await check(await workspaceLockTarget(workspace), { realpath: true, stale: 5000 });
  } finally { db.close(); }
}
