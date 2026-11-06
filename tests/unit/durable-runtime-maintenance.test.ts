import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeStore } from "../../src/services/runtime/store";
import { RuntimeCommands } from "../../src/services/runtime/commands";
import { DurableTranscript } from "../../src/services/runtime/transcript";
import { DurableCallJournal } from "../../src/services/runtime/journal";
import { backupRuntime, restoreRuntime, withOfflineRuntime, pruneRuntime } from "../../src/services/runtime/maintenance";
import { lock } from "../../src/utils/lockfile";

const roots: string[] = []; const stores: RuntimeStore[] = [];
afterEach(async () => {
  stores.splice(0).forEach((s) => s.close());
  // Bun's native SQLite statements may retain Windows file handles until collection.
  if (process.platform === "win32") Bun.gc(true);
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-maintenance-")); roots.push(root);
  const state = join(root, "runtime"); const store = new RuntimeStore(join(state, "state.sqlite")); stores.push(store);
  const created = new RuntimeCommands(store).createRun({ commandId: "create", objective: "retain work" });
  return { root, state, store, ...created };
}

test("backup and restore retain transcript decisions, operation evidence and command deduplication", async () => {
  const f = await fixture(); const taskId = f.tasks[0]!.taskId;
  const options = { store: f.store, root: f.state, runId: f.run.runId, taskId };
  await new DurableTranscript(options).append([{ role: "assistant", content: [{ type: "text", text: "saved report" }] }], false, "end-turn");
  const journal = new DurableCallJournal({ ...options, assertLive() {}, isReplaySafe: () => false });
  const call = { type: "tool-use" as const, id: "write", name: "write", input: {} };
  const id = await journal.intend(call, {}, "history"); await journal.dispatch(id);
  await writeFile(join(f.state, "control.key"), "never-export");
  const backup = await backupRuntime(f.store, f.state, join(f.root, "backup"));
  expect(JSON.stringify(JSON.parse(await readFile(join(backup, "manifest.json"), "utf8")))).not.toContain("control.key");
  const restored = join(f.root, "restored"); await restoreRuntime(backup, restored);
  const store = new RuntimeStore(join(restored, "state.sqlite")); stores.push(store);
  expect(store.getRun(f.run.runId)?.status).toBe("paused");
  expect(new RuntimeCommands(store).createRun({ commandId: "create", objective: "retain work" }).run.runId).toBe(f.run.runId);
  const transcript = new DurableTranscript({ ...options, store, root: restored });
  expect(await transcript.load()).toHaveLength(1); expect(transcript.completedReport()).toBe("saved report");
  const restoredJournal = new DurableCallJournal({ ...options, store, root: restored, assertLive() {}, isReplaySafe: () => false });
  expect(await restoredJournal.unresolved()).toHaveLength(1);
});

test("corrupt backups and unsafe paths never publish partially restored state", async () => {
  const f = await fixture(); const backup = await backupRuntime(f.store, f.state, join(f.root, "backup"));
  await writeFile(join(backup, "state.sqlite"), "corrupt");
  const target = join(f.root, "empty");
  await expect(restoreRuntime(backup, target)).rejects.toThrow("checksum"); expect(await readdir(target)).toEqual([]);
  const manifest = JSON.parse(await readFile(join(backup, "manifest.json"), "utf8")); manifest.files["../escape"] = "0".repeat(64);
  delete manifest.files["state.sqlite"]; manifest.files["state.sqlite"] = "0".repeat(64);
  await writeFile(join(backup, "manifest.json"), JSON.stringify(manifest));
  await expect(restoreRuntime(backup, target)).rejects.toThrow(); expect(await readdir(target)).toEqual([]);
});

test("offline maintenance refuses a live owner and prune refuses accepted live work", async () => {
  const f = await fixture(); const release = await lock(f.state, { realpath: true, retries: 0 });
  try { await expect(withOfflineRuntime(f.state, async () => true)).rejects.toThrow("already being held"); }
  finally { await release(); }
  await expect(pruneRuntime(f.store, f.state, f.run.runId)).rejects.toThrow("terminal");
  f.store.command("finish-fixture", {}, Date.now(), (tx) => { tx.saveRun({ ...f.run, status: "cancelled", revision: 2 }, 1); return true; });
  await pruneRuntime(f.store, f.state, f.run.runId); expect(f.store.getRun(f.run.runId)).toBeUndefined();
  // A pruned command identity remains a tombstone and cannot silently create new business work.
  expect(new RuntimeCommands(f.store).createRun({ commandId: "create", objective: "retain work" }).run.runId).toBe(f.run.runId);
});

test("pruning one Run preserves another Run's referenced evidence and reclaims orphan artifacts", async () => {
  const f = await fixture(); const { RuntimeArtifacts } = await import("../../src/services/runtime/artifacts");
  const artifacts = new RuntimeArtifacts(join(f.state, "artifacts"));
  const retained = await artifacts.put({ report: "retained evidence" }); const orphan = await artifacts.put({ report: "orphan" });
  const other = new RuntimeCommands(f.store).createRun({ commandId: "other-run", objective: "keep" });
  f.store.command("pin", {}, Date.now(), (tx) => { tx.saveRecord({ kind: "evidence", id: "pin", runId: other.run.runId, value: { resultRef: retained } }, 0); return true; });
  f.store.command("finish-prune", {}, Date.now(), (tx) => { tx.saveRun({ ...f.run, status: "cancelled", revision: 2 }, 1); return true; });
  await pruneRuntime(f.store, f.state, f.run.runId);
  expect(await artifacts.get<{ report: string }>(retained)).toEqual({ report: "retained evidence" });
  await expect(artifacts.get(orphan)).rejects.toThrow("ENOENT");
});
