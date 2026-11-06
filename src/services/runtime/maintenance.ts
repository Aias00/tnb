import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, lstat, statfs, realpath, rmdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, basename } from "node:path";
import { RuntimeStore } from "./store";
import { lock } from "../../utils/lockfile";
import { DurableTranscript } from "./transcript";
import { DurableCallJournal } from "./journal";

import { backupHash as hash, inspectBackupEvidence, readBackupFile, readBackupManifest, safeBackupPath, walkPluginEvidence, type BackupManifest, type BackupInspection } from "./backup-evidence";
export type { BackupInspection } from "./backup-evidence";

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return; // Windows has no Node directory fsync; file flushes still precede publication.
  const file = await open(path, "r"); try { await file.sync(); } finally { await file.close(); }
}
async function durableWrite(path: string, data: string | Uint8Array, executable = false): Promise<void> {
  const parent = resolve(path, ".."); await mkdir(parent, { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(data); if (executable) await file.chmod(0o700); await file.sync(); } finally { await file.close(); }
  await syncDirectory(parent);
}

/** Maintenance runs offline under the same owner lock as the service. Never copy live WAL files. */
export async function withOfflineRuntime<T>(root: string, operation: (store: RuntimeStore) => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const release = await lock(root, { realpath: true, retries: 0, stale: 5000, update: 1000 });
  let store: RuntimeStore | undefined;
  try {
    await lstat(join(root, "state.sqlite"));
    store = new RuntimeStore(join(root, "state.sqlite")); return await operation(store);
  } finally { store?.close(); await release(); }
}
export async function backupRuntime(store: RuntimeStore, root: string, destination: string): Promise<string> {
  const parent = await realpath(resolve(destination, "..")); const target = join(parent, basename(resolve(destination)));
  const stateRoot = await realpath(root); const rel = relative(stateRoot, target);
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Backups must be outside the runtime state directory");
  try { await lstat(target); throw new Error("Backup destination already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(temporary, { mode: 0o700 }); const files: Record<string, string> = {};
  const directories: string[] = [], executables: string[] = []; let totalBytes = 0, fileCount = 0;
  async function put(name: string, data: Uint8Array, executable = false) {
    if (!safeBackupPath(name, 2)) throw new Error("Invalid backup evidence path");
    if (++fileCount > 100000 || data.byteLength > 512 * 1024 * 1024 || (totalBytes += data.byteLength) > 10 * 1024 ** 3) throw new Error("Backup evidence exceeds supported limits");
    await durableWrite(join(temporary, name), data, executable); files[name] = hash(data); if (executable) executables.push(name);
  }
  try {
    // Validate both sides of every bridge before declaring the backup complete. Repair
    // pending deliveries by their saved identities; unknown effects remain unknown.
    for (const run of store.runs()) for (const task of store.tasks(run.runId)) {
      const options = { store, root, runId: run.runId, taskId: task.taskId };
      await new DurableTranscript(options).load();
      const journal = new DurableCallJournal({ ...options, assertLive() {}, isReplaySafe: () => false });
      for (const operation of store.operationHeaders(run.runId, task.taskId)) await journal.lookup(operation.id);
    }
    const snapshot = store.snapshot();
    if (snapshot.byteLength > 512 * 1024 * 1024) throw new Error("Backup database exceeds the supported 512 MiB snapshot limit");
    await put("state.sqlite", snapshot);
    const db = new Database(join(temporary, "state.sqlite"), { readonly: true });
    try {
      // Iterate one bounded record at a time rather than loading all model/tool outcomes.
      for (const row of db.query("SELECT record_id, task_id, json_extract(value,'$.state') AS state FROM runtime_records WHERE kind = 'operation'").iterate() as Iterable<{ record_id: string; task_id: string; state: string }>) {
        const name = `${row.task_id}/operations/${row.record_id}.jsonl`;
        try { await put(name, await readBackupFile(root, name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || row.state !== "intended") throw error; }
      }
      for (const row of db.query("SELECT DISTINCT task_id FROM runtime_records WHERE kind = 'message'").iterate() as Iterable<{ task_id: string }>) {
        const name = `${row.task_id}/transcript.jsonl`; const bytes = await readBackupFile(root, name);
        if (bytes.length > 64 * 1024 * 1024) throw new Error("Transcript exceeds backup limit");
        // Offline ownership makes this exact file and database snapshot consistent, including pending deliveries.
        await put(name, bytes);
      }
      for (const entry of await readdir(join(root, "artifacts")).catch(() => [])) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
        const bytes = await readBackupFile(root, `artifacts/${entry}`);
        if (hash(bytes) !== entry.slice(0, -5)) throw new Error("Backup artifact integrity failure");
        await put(`artifacts/${entry}`, bytes);
      }
    } finally { db.close(); }
    await walkPluginEvidence(root, async name => {
      directories.push(name); await mkdir(join(temporary, name), { recursive: true, mode: 0o700 }); await syncDirectory(resolve(join(temporary, name), ".."));
    }, async (name, executable) => put(name, await readBackupFile(root, name), executable));
    const manifest: BackupManifest = { version: 2, createdAt: Date.now(), files, directories, executables };
    await inspectBackupEvidence(temporary, manifest, totalBytes);
    const encoded = JSON.stringify(manifest);
    if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) throw new Error("Backup manifest exceeds limit");
    await durableWrite(join(temporary, "manifest.json"), encoded);
    await syncDirectory(temporary); await rename(temporary, target); await syncDirectory(parent); return target;
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

export async function restoreRuntime(backup: string, root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 }); root = await realpath(root);
  const release = await lock(root, { realpath: true, retries: 0, stale: 5000, update: 1000 });
  const staging = `${root}.restore-${randomUUID()}`;
  try {
    if ((await readdir(root)).length) throw new Error("Restore requires an empty runtime directory");
    const manifest = await readBackupManifest(backup);
    await mkdir(staging, { mode: 0o700 }); let size = 0;
    for (const name of manifest.directories ?? []) {
      await mkdir(join(staging, name), { recursive: true, mode: 0o700 }); await syncDirectory(resolve(join(staging, name), ".."));
    }
    const executables = new Set(manifest.executables ?? []);
    for (const [name, expected] of Object.entries(manifest.files)) {
      const bytes = await readBackupFile(backup, name);
      if ((size += bytes.byteLength) > 10 * 1024 ** 3) throw new Error("Oversized backup evidence");
      if (hash(bytes) !== expected) throw new Error("Backup checksum failure");
      if (name.startsWith("artifacts/") && hash(bytes) !== basename(name, ".json")) throw new Error("Backup artifact integrity failure");
      await durableWrite(join(staging, name), bytes, executables.has(name));
    }
    // Recheck the exact private staging bytes that will be published, including package fingerprints.
    await inspectBackupEvidence(staging, manifest, size);
    const db = new RuntimeStore(join(staging, "state.sqlite"));
    try {
      for (const run of db.runs()) if (["active", "pausing"].includes(run.status)) db.command(randomUUID(), { kind: "restore.review", runId: run.runId }, Date.now(), (tx) => {
        tx.saveRun({ ...run, status: "paused", revision: run.revision + 1, updatedAt: Date.now() }, run.revision);
        tx.event(run.runId, "run.restored", { backupCreatedAt: manifest.createdAt, reviewRequired: true }); return true;
      });
    } finally { db.close(); }
    // Publish the fully verified directory only. Failed verification leaves the target empty.
    await syncDirectory(staging); await rmdir(root); await rename(staging, root); await syncDirectory(resolve(root, ".."));
  } finally { await rm(staging, { recursive: true, force: true }); await release(); }
}

/** Read only: does not restore, import plugin code, mutate SQLite or acquire the live owner's lock. */
export async function checkRuntimeBackup(backup: string): Promise<BackupInspection> {
  const manifest = await readBackupManifest(backup); let size = 0;
  for (const [name, checksum] of Object.entries(manifest.files)) {
    const bytes = await readBackupFile(backup, name);
    if ((size += bytes.byteLength) > 10 * 1024 ** 3) throw new Error("Oversized backup evidence");
    if (hash(bytes) !== checksum) throw new Error("Backup checksum failure");
    if (name.startsWith("artifacts/") && hash(bytes) !== basename(name, ".json")) throw new Error("Backup artifact integrity failure");
  }
  return inspectBackupEvidence(backup, manifest, size);
}

export async function runtimeStorageUsage(root: string): Promise<{ bytes: number; freeBytes: number }> {
  let bytes = 0; let entries = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 100000) throw new Error("Runtime storage entry limit reached");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path); else if (entry.isFile()) bytes += (await lstat(path)).size;
    }
  }
  await walk(root); const fs = await statfs(root); return { bytes, freeBytes: fs.bavail * fs.bsize };
}

export async function pruneRuntime(store: RuntimeStore, root: string, runId: string): Promise<void> {
  const taskIds = store.deleteTerminalRun(runId);
  for (const id of taskIds) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Unsafe task directory identity");
    await rm(join(root, id), { recursive: true, force: true });
  }
  const retained = store.artifactReferences();
  for (const name of await readdir(join(root, "artifacts")).catch(() => [])) {
    if (/^[a-f0-9]{64}\.json$/.test(name) && !retained.has(name.slice(0, -5))) await rm(join(root, "artifacts", name));
  }
  // Receipts remain identity tombstones. Evidence for a pruned Run is explicitly removed;
  // every reference in retained task state, events and execution records remains pinned.
  const databaseBytes = (await lstat(store.path)).size;
  const disk = await statfs(root);
  if (disk.bavail * disk.bsize > databaseBytes * 2 + 256 * 1024 ** 2) store.compact();
}
