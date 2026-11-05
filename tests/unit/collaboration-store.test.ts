import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeStore } from "../../src/services/runtime/store";
import { RuntimeCommands } from "../../src/services/runtime/commands";
import { RUNTIME_SCHEMA_VERSION } from "../../src/services/runtime/schema";
import { backupRuntime, restoreRuntime } from "../../src/services/runtime/maintenance";

const stores: RuntimeStore[] = [], roots: string[] = [];
afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "tnb-collab-store-")); roots.push(root); const path = join(root, "runtime", "state.sqlite"), store = new RuntimeStore(path); stores.push(store); return { root, path, store }; }

test("all recognized schema generations migrate without losing runs or receipts", async () => {
  for (const version of [1, 2, 3, 4]) {
    const f = await fixture(), commands = new RuntimeCommands(f.store);
    const input = { commandId: "original", objective: "Keep this Run" }, created = commands.createRun(input);
    f.store.close(); const db = new Database(f.path);
    db.exec("DROP TABLE application_records");
    if (version < 4) db.exec("DROP TABLE routing_tombstones; DROP INDEX routing_pending");
    if (version < 3) db.exec("DROP TABLE routing_inputs");
    if (version < 2) db.exec("DROP TABLE runtime_records");
    db.exec(`PRAGMA user_version=${version}`); db.close();
    const migrated = new RuntimeStore(f.path); stores.push(migrated);
    expect(new RuntimeCommands(migrated).createRun(input).run.runId).toBe(created.run.runId);
    migrated.command("app", {}, Date.now(), tx => tx.saveApplicationRecord({ namespace: "demo", id: "before-run", value: { admitted: true } }, 0));
    expect(migrated.applicationRecord("demo", "before-run")?.revision).toBe(1);
    const read = new Database(f.path, { readonly: true }); expect(read.query("PRAGMA user_version").get()).toEqual({ user_version: RUNTIME_SCHEMA_VERSION }); read.close();
  }
});

test("application CAS, pagination, receipts and FK protection survive snapshot and offline backup", async () => {
  const f = await fixture(), commands = new RuntimeCommands(f.store), { run } = commands.createRun({ commandId: "run", objective: "Protected task" });
  const save = () => f.store.command("admission", { immutable: true }, Date.now(), tx => tx.saveApplicationRecord({ namespace: "collaboration.tickets", id: "a", runId: run.runId, value: { status: "accepted" } }, 0));
  expect(save()).toEqual(save());
  expect(() => f.store.command("bad", {}, Date.now(), tx => tx.saveApplicationRecord({ namespace: "collaboration.tickets", id: "a", runId: run.runId, value: {} }, 2))).toThrow("revision conflict");
  f.store.command("b", {}, Date.now(), tx => tx.saveApplicationRecord({ namespace: "collaboration.tickets", id: "b", value: { outside: true } }, 0));
  expect(f.store.applicationRecords("collaboration.tickets", "a", 1)[0]?.id).toBe("b");
  f.store.command("finish-fixture", {}, Date.now(), tx => {
    const task = tx.tasks(run.runId)[0]!;
    tx.saveTask({ ...task, status: "cancelled", revision: task.revision + 1 }, task.revision);
    tx.saveRun({ ...run, status: "cancelled", revision: run.revision + 1 }, run.revision); return true;
  });
  expect(() => f.store.deleteTerminalRun(run.runId)).toThrow();
  expect(f.store.getRun(run.runId)?.status).toBe("cancelled"); expect(f.store.tasks(run.runId)).toHaveLength(1);
  const snapshot = join(f.root, "snapshot.sqlite"); await writeFile(snapshot, f.store.snapshot());
  const reopened = new RuntimeStore(snapshot); stores.push(reopened); expect(reopened.applicationRecord("collaboration.tickets", "a")).toEqual(save());
  const backup = await backupRuntime(f.store, join(f.root, "runtime"), join(f.root, "backup"));
  const restored = join(f.root, "restored"); await restoreRuntime(backup, restored);
  const restoredStore = new RuntimeStore(join(restored, "state.sqlite")); stores.push(restoredStore);
  expect(restoredStore.applicationRecord("collaboration.tickets", "a")).toEqual(save());
});
