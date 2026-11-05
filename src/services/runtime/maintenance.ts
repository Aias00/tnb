import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, lstat, statfs, realpath, rmdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { RuntimeStore } from "./store";
import { lock } from "../../utils/lockfile";
import { DurableTranscript } from "./transcript";
import { DurableCallJournal } from "./journal";

type BackupManifest = { version: 1; createdAt: number; files: Record<string, string> };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const safeName = (name: string) => name === "state.sqlite" || /^artifacts\/[a-f0-9]{64}\.json$/.test(name)
  || /^[a-f0-9-]{36}\/(transcript\.jsonl|operations\/[a-f0-9]{64}\.jsonl)$/.test(name);
export async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, "r"); try { await file.sync(); } finally { await file.close(); }
}
async function durableWrite(path: string, data: string | Uint8Array): Promise<void> {
  const parent = resolve(path, ".."); await mkdir(parent, { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
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
  const parent = await realpath(resolve(destination, "..")); const target = join(parent, resolve(destination).split("/").at(-1)!);
  const stateRoot = await realpath(root); const rel = relative(stateRoot, target);
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Backups must be outside the runtime state directory");
  try { await lstat(target); throw new Error("Backup destination already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(temporary, { mode: 0o700 }); const files: Record<string, string> = {};
  async function put(name: string, data: Uint8Array) {
    if (!safeName(name)) throw new Error("Invalid backup evidence path");
    await durableWrite(join(temporary, name), data); files[name] = hash(data);
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
        try { await put(name, await readFile(join(root, name))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || row.state !== "intended") throw error; }
      }
      for (const row of db.query("SELECT DISTINCT task_id FROM runtime_records WHERE kind = 'message'").iterate() as Iterable<{ task_id: string }>) {
        const name = `${row.task_id}/transcript.jsonl`; const bytes = await readFile(join(root, name));
        if (bytes.length > 64 * 1024 * 1024) throw new Error("Transcript exceeds backup limit");
        // Offline ownership makes this exact file and database snapshot consistent, including pending deliveries.
        await put(name, bytes);
      }
      for (const entry of await readdir(join(root, "artifacts")).catch(() => [])) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
        const bytes = await readFile(join(root, "artifacts", entry));
        if (hash(bytes) !== entry.slice(0, -5)) throw new Error("Backup artifact integrity failure");
        await put(`artifacts/${entry}`, bytes);
      }
    } finally { db.close(); }
    await durableWrite(join(temporary, "manifest.json"), JSON.stringify({ version: 1, createdAt: Date.now(), files } satisfies BackupManifest));
    await syncDirectory(temporary); await rename(temporary, target); await syncDirectory(parent); return target;
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

export async function restoreRuntime(backup: string, root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 }); root = await realpath(root);
  const release = await lock(root, { realpath: true, retries: 0, stale: 5000, update: 1000 });
  const staging = `${root}.restore-${randomUUID()}`;
  try {
    if ((await readdir(root)).length) throw new Error("Restore requires an empty runtime directory");
    if ((await lstat(join(backup, "manifest.json"))).size > 16 * 1024 * 1024) throw new Error("Backup manifest exceeds limit");
    const manifest = JSON.parse(await readFile(join(backup, "manifest.json"), "utf8")) as BackupManifest;
    if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== "object" || !manifest.files["state.sqlite"]
      || Object.keys(manifest.files).length > 100000) throw new Error("Invalid backup manifest");
    await mkdir(staging, { mode: 0o700 }); let size = 0;
    for (const [name, expected] of Object.entries(manifest.files)) {
      if (!safeName(name) || typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Unsafe backup path or checksum");
      const source = join(backup, name); const canonical = await realpath(source); const rel = relative(await realpath(backup), canonical);
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || rel.startsWith("..") || isAbsolute(rel)
        || info.size > 512 * 1024 * 1024 || (size += info.size) > 10 * 1024 ** 3) throw new Error("Unsafe or oversized backup evidence");
      const bytes = await readFile(source);
      if (hash(bytes) !== expected) throw new Error("Backup checksum failure");
      await durableWrite(join(staging, name), bytes);
    }
    const snapshot = new Database(join(staging, "state.sqlite"), { readonly: true }); try {
      if ((snapshot.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check !== "ok"
        || snapshot.query("PRAGMA foreign_key_check").all().length) throw new Error("Backup database integrity failure");
    } finally { snapshot.close(); }
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
