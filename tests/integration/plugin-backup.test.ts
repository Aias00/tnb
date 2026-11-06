import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../../src/services/runtime/store";
import { RuntimeCommands } from "../../src/services/runtime/commands";
import { backupRuntime, checkRuntimeBackup, restoreRuntime } from "../../src/services/runtime/maintenance";
import { backupHash, type BackupManifest } from "../../src/services/runtime/backup-evidence";
import { computePluginTreeSha256, revokePluginTrust, trustPlugin } from "../../src/services/plugins/trust";
import { pluginGenerationKey, pluginGenerationReferences, readRetainedPlugin, retainPluginGeneration } from "../../src/agent/plugin-generations";
import { loadHostPlugins } from "../../src/agent/plugins";
import { DomainRegistry } from "../../src/agent/domain";
import { saveChannelBinding } from "../../src/agent/channel-bindings";
import { runRuntimeChatCommand, runRuntimeCommand } from "../../src/entrypoints/runtime";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(archive = true, builtin = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tnb-plugin-backup-"))); cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const runtime = join(root, "runtime"), pack = join(root, "plugins", "restore-pack"), trust = join(root, "trust.json"), marker = join(root, "imported");
  await mkdir(pack, { recursive: true });
  await writeFile(join(pack, "plugin.json"), JSON.stringify({ name: "restore-pack", version: "1.0.0", manifestVersion: 2, apiVersion: "tnb.plugin/v1", contributes: { adapters: [{ id: "fixture", version: "1", entry: "index.mjs" }] } }));
  await writeFile(join(pack, "index.mjs"), `await Bun.write(${JSON.stringify(marker)},'imported');export default api=>api.registerAdapter({id:'fixture',version:'1',validate(){},async createWorker(){throw new Error('not used')},async snapshot(){return {}},async accept(){return {checks:[]}}});`);
  await chmod(join(pack, "index.mjs"), 0o755); await mkdir(join(pack, "empty"));
  if (builtin) await writeFile(join(pack, "runtime.json"), JSON.stringify({ protocol: "tnb.domain/v1", bun: "incompatible-version", platform: process.platform, arch: process.arch }));
  const identity = { name: "restore-pack", version: "1.0.0", fingerprint: await computePluginTreeSha256(pack) };
  const domain = { id: "fixture", version: "1", plugin: identity, config: {}, resources: [{ id: "fact", mode: "read" as const }], grants: [] };
  const store = new RuntimeStore(join(runtime, "state.sqlite")); cleanup.push(async () => { store.close(); if (process.platform === "win32") Bun.gc(true); });
  const { run } = new RuntimeCommands(store).createRun({ commandId: "fixture", objective: "Recover pinned implementation", configuration: { domain } });
  const generation = pluginGenerationKey(identity), history = join(runtime, "plugin-generations");
  if (archive) await retainPluginGeneration(history, identity, builtin ? "builtin:restore-pack" : pack, pack);
  const stateId = "c".repeat(64), stateDirectory = join(runtime, "plugin-state", stateId);
  await mkdir(join(stateDirectory, "empty-state"), { recursive: true }); await writeFile(join(stateDirectory, "data.bin"), new Uint8Array([0, 1, 2, 255]));
  await writeFile(join(runtime, "control.key"), "must-not-export-control-key");
  const backup = () => backupRuntime(store, runtime, join(root, "backup"));
  return { root, runtime, pack, marker, trust, identity, domain, store, run, generation, history, stateDirectory, stateId, backup };
}
async function manifest(path: string) { return JSON.parse(await readFile(join(path, "manifest.json"), "utf8")) as BackupManifest; }

test("backup v2 includes archived code, empty directories, executable identity and binary private files without importing plugins", async () => {
  const f = await fixture(), backup = await f.backup(), report = await checkRuntimeBackup(backup);
  expect(report).toMatchObject({ version: 2, integrity: "verified", plugins: { coverage: "included", pinnedGenerations: 1, archivedGenerations: 1, privateStateDirectories: 1 } });
  expect(report.requirements).toContain("current-host-trust-and-approval");
  expect(await readFile(f.marker, "utf8").catch(() => "")).toBe("");
  const inventory = await manifest(backup);
  expect(inventory.directories).toContain(`plugin-generations/${f.generation}/package/empty`); expect(inventory.directories).toContain(`plugin-state/${f.stateId}/empty-state`);
  expect(Object.keys(inventory.files)).not.toContain("control.key");
  expect(new Uint8Array(await readFile(join(backup, "plugin-state", f.stateId, "data.bin")))).toEqual(new Uint8Array([0, 1, 2, 255]));
  const restored = join(f.root, "restored"); await restoreRuntime(backup, restored);
  const retained = await readRetainedPlugin(join(restored, "plugin-generations"), f.identity); expect(retained.plugin.fingerprint).toBe(f.identity.fingerprint);
  expect((await lstat(join(restored, "plugin-state", f.stateId, "empty-state"))).isDirectory()).toBe(true);
  if (process.platform !== "win32") expect((await lstat(join(restored, "plugin-generations", f.generation, "package", "index.mjs"))).mode & 0o111).not.toBe(0);
});

test("restored SQLite binds the original implementation while current installations keep their own generation", async () => {
  const f = await fixture(); await trustPlugin(f.trust, f.pack); const backup = await f.backup();
  await writeFile(join(f.pack, "new-release.txt"), "upgraded bytes"); await trustPlugin(f.trust, f.pack);
  const restored = join(f.root, "restored"); await restoreRuntime(backup, restored);
  const store = new RuntimeStore(join(restored, "state.sqlite")); cleanup.push(async () => { store.close(); if (process.platform === "win32") Bun.gc(true); });
  expect(store.getRun(f.run.runId)?.status).toBe("paused");
  const host = await loadHostPlugins({ roots: [{ directory: join(f.root, "plugins"), source: "user" }], trustStorePath: f.trust, generationReferences: pluginGenerationReferences(store) }, [], join(restored, "plugin-snapshots")); cleanup.push(() => host.close());
  expect(host.list().map(row => [row.generation, row.status])).toEqual([["current", "active"], ["retained", "active"]]);
  const registry = new DomainRegistry([], host.registrations); expect(registry.resolve(f.domain).id).toBe("fixture");
  const { plugin: _identity, ...unbound } = f.domain;
  expect(registry.prepare(unbound).plugin?.fingerprint).not.toBe(f.identity.fingerprint);
});

test("missing pinned archives fail backup publication instead of declaring incomplete plugin coverage", async () => {
  const f = await fixture(false); await expect(f.backup()).rejects.toThrow("missing a referenced plugin generation");
  expect((await readdir(f.root)).some(name => name === "backup" || name.startsWith("backup."))).toBe(false);
});

test("checksum-correct but fingerprint-invalid archives fail verification and never publish restore targets", async () => {
  const f = await fixture(), backup = await f.backup(), inventory = await manifest(backup), name = `plugin-generations/${f.generation}/package/index.mjs`;
  const changed = "export default ()=>{};"; await writeFile(join(backup, name), changed); inventory.files[name] = backupHash(Buffer.from(changed));
  await writeFile(join(backup, "manifest.json"), JSON.stringify(inventory));
  await expect(checkRuntimeBackup(backup)).rejects.toThrow("fingerprint mismatch");
  const target = join(f.root, "restore-failed"); await expect(restoreRuntime(backup, target)).rejects.toThrow("fingerprint mismatch"); expect(await readdir(target)).toEqual([]);
});

test("manifest omission cannot hide required plugin files or empty code directories", async () => {
  const f = await fixture(), backup = await f.backup(), inventory = await manifest(backup);
  delete inventory.files[`plugin-generations/${f.generation}/package/index.mjs`];
  inventory.executables = inventory.executables?.filter(name => name !== `plugin-generations/${f.generation}/package/index.mjs`);
  await writeFile(join(backup, "manifest.json"), JSON.stringify(inventory));
  await expect(checkRuntimeBackup(backup)).rejects.toThrow("not covered by manifest");
  const target = join(f.root, "restore-failed"); await expect(restoreRuntime(backup, target)).rejects.toThrow("fingerprint mismatch"); expect(await readdir(target)).toEqual([]);
});

test("v1 backups remain restorable while reporting their absent plugin file coverage", async () => {
  const f = await fixture(false); f.store.command("remove-pins", {}, Date.now(), tx => { const row = tx.record<{ domain?: unknown }>("configuration", f.run.runId)!; tx.saveRecord({ ...row, value: {} }, row.revision); return true; });
  await rm(join(f.runtime, "plugin-state"), { recursive: true });
  const backup = await f.backup(), inventory = await manifest(backup); inventory.version = 1; delete inventory.directories; delete inventory.executables;
  await writeFile(join(backup, "manifest.json"), JSON.stringify(inventory));
  const report = await checkRuntimeBackup(backup); expect(report.plugins.coverage).toBe("not-covered"); expect(report.compatibility.issues[0]?.code).toBe("LEGACY_PLUGIN_ASSETS_NOT_COVERED");
  await restoreRuntime(backup, join(f.root, "restored"));
});

test("ABI mismatch is distinguished from corrupt backup material without executing archived code", async () => {
  const f = await fixture(true, true), backup = await f.backup(), report = await checkRuntimeBackup(backup);
  expect(report.integrity).toBe("verified"); expect(report.compatibility.status).toBe("review-required"); expect(report.compatibility.issues).toContainEqual({ code: "PLUGIN_RECOVERY_ABI", plugin: f.identity });
  expect(await readFile(f.marker, "utf8").catch(() => "")).toBe("");
});

test("channel-only references require their generation even without a Run binding", async () => {
  const f = await fixture();
  const missing = { ...f.identity, fingerprint: "d".repeat(64) };
  saveChannelBinding(f.store, { owner: "application", key: "source", transport: "plugin", descriptor: { id: "channel", version: "1", plugin: missing } });
  await expect(f.backup()).rejects.toThrow("missing a referenced plugin generation");
});

test("backup-check is read-only, leaves no owner state and does not modify backup bytes", async () => {
  const f = await fixture(), backup = await f.backup(), before = backupHash(await readFile(join(backup, "state.sqlite"))), configDir = join(f.root, "unused-config");
  let stdout = "", stderr = "";
  expect(await runRuntimeCommand({ argv: ["runtime", "backup-check", backup, "--config-dir", configDir], cwd: f.root, env: {}, stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } })).toBe(0);
  expect(stderr).toBe(""); expect(JSON.parse(stdout).integrity).toBe("verified");
  expect(backupHash(await readFile(join(backup, "state.sqlite")))).toBe(before); expect(await readdir(configDir).catch(() => [])).toEqual([]);
  expect((await readdir(backup)).some(name => name.endsWith("-wal") || name.endsWith("-shm"))).toBe(false);
  const conversation = await runRuntimeChatCommand({ args: ["backup-check", backup], cwd: f.root, workspace: f.root, configDir, env: {}, provider: "unused", model: "unused", sessionId: "offline-check" });
  expect(JSON.parse(conversation).integrity).toBe("verified"); expect(await readdir(configDir).catch(() => [])).toEqual([]);
});

test.skipIf(process.platform === "win32")("source symlinks and backup ancestor symlinks cannot export or restore outside files", async () => {
  const f = await fixture(), secret = join(f.root, "outside-secret"); await writeFile(secret, "private");
  await symlink(secret, join(f.stateDirectory, "secret")); await expect(f.backup()).rejects.toThrow("symbolic");
  await rm(join(f.stateDirectory, "secret")); const backup = await f.backup();
  const actual = join(f.root, "state-moved"); const { rename } = await import("node:fs/promises");
  await rename(join(backup, "plugin-state", f.stateId), actual); await symlink(actual, join(backup, "plugin-state", f.stateId));
  await expect(checkRuntimeBackup(backup)).rejects.toThrow("symbolic");
  const target = join(f.root, "restore-failed"); await expect(restoreRuntime(backup, target)).rejects.toThrow("symbolic"); expect(await readdir(target)).toEqual([]);
});

test("restoring archives never restores an approval revoked in the current host trust store", async () => {
  const f = await fixture(); await trustPlugin(f.trust, f.pack); const backup = await f.backup();
  await writeFile(join(f.pack, "updated.txt"), "current generation"); await revokePluginTrust(f.trust, f.pack); await trustPlugin(f.trust, f.pack);
  const restored = join(f.root, "restored"); await restoreRuntime(backup, restored);
  const store = new RuntimeStore(join(restored, "state.sqlite")); cleanup.push(async () => { store.close(); if (process.platform === "win32") Bun.gc(true); });
  const host = await loadHostPlugins({ roots: [{ directory: join(f.root, "plugins"), source: "user" }], trustStorePath: f.trust, generationReferences: pluginGenerationReferences(store) }, [], join(restored, "plugin-snapshots")); cleanup.push(() => host.close());
  expect(host.list().find(row => row.generation === "retained")?.error).toContain("no longer trusted");
});

test("deleting both a pinned generation and its inventory cannot make a v2 backup pass", async () => {
  const f = await fixture(), backup = await f.backup(), inventory = await manifest(backup), prefix = `plugin-generations/${f.generation}`;
  for (const name of Object.keys(inventory.files)) if (name.startsWith(prefix + "/")) delete inventory.files[name];
  inventory.directories = inventory.directories?.filter(name => !name.startsWith(prefix)); inventory.executables = inventory.executables?.filter(name => !name.startsWith(prefix));
  await rm(join(backup, prefix), { recursive: true }); await writeFile(join(backup, "manifest.json"), JSON.stringify(inventory));
  await expect(checkRuntimeBackup(backup)).rejects.toThrow("missing a referenced plugin generation");
});

test("unsafe v2 paths, executable entries and directory aliases fail before target publication", async () => {
  const f = await fixture(), backup = await f.backup(), original = await manifest(backup);
  for (const mutation of [
    (value: BackupManifest) => { value.files[`plugin-state/${f.stateId}/../escape`] = "0".repeat(64); },
    (value: BackupManifest) => { value.directories!.push(`plugin-state/${f.stateId}/../../escape`); },
    (value: BackupManifest) => { value.executables!.push("state.sqlite"); },
    (value: BackupManifest) => { value.files[`plugin-state/${f.stateId}/stream:secret`] = "0".repeat(64); },
  ]) {
    const invalid = structuredClone(original); mutation(invalid); await writeFile(join(backup, "manifest.json"), JSON.stringify(invalid));
    await expect(checkRuntimeBackup(backup)).rejects.toThrow("Unsafe");
    const target = join(f.root, "restore-failed"); await expect(restoreRuntime(backup, target)).rejects.toThrow("Unsafe"); expect(await readdir(target)).toEqual([]);
  }
});

test("artifact checksums must also match their content address, even when the manifest is rewritten", async () => {
  const f = await fixture(), artifacts = join(f.runtime, "artifacts"); await mkdir(artifacts);
  const bytes = Buffer.from('{"fact":"original"}'), name = `artifacts/${backupHash(bytes)}.json`; await writeFile(join(f.runtime, name), bytes);
  const backup = await f.backup(), inventory = await manifest(backup), tampered = Buffer.from('{"fact":"tampered"}');
  await writeFile(join(backup, name), tampered); inventory.files[name] = backupHash(tampered); await writeFile(join(backup, "manifest.json"), JSON.stringify(inventory));
  await expect(checkRuntimeBackup(backup)).rejects.toThrow("artifact integrity");
});

test.skipIf(process.platform === "win32")("recorded executable flags preserve identity when backup transport drops POSIX permissions", async () => {
  const f = await fixture(), backup = await f.backup(), file = join(backup, "plugin-generations", f.generation, "package", "index.mjs");
  await chmod(file, 0o600);
  const report = await checkRuntimeBackup(backup); expect(report.integrity).toBe("verified"); expect(report.compatibility.issues).toContainEqual({ code: "PLUGIN_EXECUTABLE_MODE", plugin: f.identity });
  const restored = join(f.root, "restored"); await restoreRuntime(backup, restored);
  expect((await readRetainedPlugin(join(restored, "plugin-generations"), f.identity)).plugin.fingerprint).toBe(f.identity.fingerprint);
});

test("empty code directories and executable flags remain part of the archived content fingerprint", async () => {
  const f = await fixture(), backup = await f.backup(), inventory = await manifest(backup), empty = `plugin-generations/${f.generation}/package/empty`;
  await rm(join(backup, empty), { recursive: true }); inventory.directories = inventory.directories?.filter(name => name !== empty);
  await writeFile(join(backup, "manifest.json"), JSON.stringify(inventory));
  await expect(checkRuntimeBackup(backup)).rejects.toThrow("fingerprint mismatch");
});

test("legacy backups with pinned tasks stay explicitly incomplete and do not invent missing archives", async () => {
  const f = await fixture(), backup = await f.backup(), inventory = await manifest(backup);
  for (const name of Object.keys(inventory.files)) if (name.startsWith("plugin-")) delete inventory.files[name];
  await rm(join(backup, "plugin-generations"), { recursive: true }); await rm(join(backup, "plugin-state"), { recursive: true });
  inventory.version = 1; delete inventory.directories; delete inventory.executables; await writeFile(join(backup, "manifest.json"), JSON.stringify(inventory));
  const report = await checkRuntimeBackup(backup); expect(report.plugins).toMatchObject({ coverage: "not-covered", pinnedGenerations: 1, archivedGenerations: 0 });
  const restored = join(f.root, "restored"); await restoreRuntime(backup, restored);
  expect(await readdir(join(restored, "plugin-generations")).catch(() => [])).toEqual([]);
});
