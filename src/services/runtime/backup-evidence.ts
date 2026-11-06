import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { constants } from "node:fs";
import { validateDomainDescriptor, type AdapterPluginIdentity } from "../../agent/domain";
import { pluginGenerationKey } from "../../agent/plugin-generations";
import { builtinRecoveryABI, channelRecoveryABI } from "../../agent/builtin-generations";
import { loadPlugins } from "../plugins/loader";
import { digestJson } from "./json";

export type BackupManifest = { version: 1 | 2; createdAt: number; files: Record<string, string>; directories?: string[]; executables?: string[] };
export type BackupInspection = {
  version: 1 | 2; createdAt: number; integrity: "verified"; files: number; bytes: number;
  plugins: { coverage: "included" | "not-covered"; pinnedGenerations: number; archivedGenerations: number; privateStateDirectories: number };
  compatibility: { status: "compatible" | "review-required"; issues: Array<{ code: string; plugin?: AdapterPluginIdentity }> };
  requirements: string[];
};
export const backupHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function safeBackupPath(name: string, version: 1 | 2, directory = false): boolean {
  if (typeof name !== "string" || name.length > 4096 || name.includes("\\") || name.includes(":")) return false;
  const parts = name.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[\x00-\x1f]/.test(part)) || parts.length > 32) return false;
  if (!directory && (name === "state.sqlite" || /^artifacts\/[a-f0-9]{64}\.json$/.test(name)
    || /^[a-f0-9-]{36}\/(transcript\.jsonl|operations\/[a-f0-9]{64}\.jsonl)$/.test(name))) return true;
  if (version !== 2) return false;
  if (parts[0] === "plugin-state" && /^[a-f0-9]{64}$/.test(parts[1] ?? "")) return directory || parts.length > 2;
  if (parts[0] === "plugin-generations" && /^[a-f0-9]{64}$/.test(parts[1] ?? "")) {
    return directory ? parts.length === 2 || parts[2] === "package" : parts.length === 3 && parts[2] === "generation.json" || parts.length > 3 && parts[2] === "package";
  }
  return false;
}
export async function readBackupFile(root: string, name: string): Promise<Buffer> {
  const base = await realpath(root); let path = base;
  for (const component of name.split("/")) {
    path = join(path, component);
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Backup evidence cannot contain symbolic links");
  }
  const rel = relative(base, await realpath(path));
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error("Unsafe backup evidence path");
  // Recheck the opened descriptor, including no-follow semantics on POSIX.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 512 * 1024 * 1024) throw new Error("Unsafe or oversized backup evidence"); return await file.readFile(); }
  finally { await file.close(); }
}
export async function walkPluginEvidence(root: string, onDirectory: (name: string) => Promise<void>, onFile: (name: string, executable: boolean) => Promise<void>): Promise<void> {
  let entries = 0, directories = 0;
  const walk = async (name: string): Promise<void> => {
    if (++entries > 110000 || !safeBackupPath(name, 2, true) && !safeBackupPath(name, 2)) throw new Error("Unsafe or excessive plugin backup tree");
    const info = await lstat(join(root, name));
    if (info.isSymbolicLink()) throw new Error("Plugin backup evidence cannot contain symbolic links");
    if (info.isDirectory()) {
      if (!safeBackupPath(name, 2, true) || ++directories > 10000) throw new Error("Invalid or excessive plugin backup directories");
      await onDirectory(name);
      for (const entry of await readdir(join(root, name))) await walk(`${name}/${entry}`);
    } else if (info.isFile()) { if (!safeBackupPath(name, 2)) throw new Error("Invalid plugin backup file"); await onFile(name, (info.mode & 0o111) !== 0); }
    else throw new Error("Plugin backup contains unsupported special files");
  };
  for (const parent of ["plugin-generations", "plugin-state"]) {
    let info;
    try { info = await lstat(join(root, parent)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Plugin backup root must be a real directory");
    for (const entry of await readdir(join(root, parent))) {
      if (parent === "plugin-generations" && entry.startsWith(".stage-")) continue;
      if (!/^[a-f0-9]{64}$/.test(entry)) throw new Error("Invalid plugin backup state or generation directory");
      await walk(`${parent}/${entry}`);
    }
  }
}
export async function readBackupManifest(root: string): Promise<BackupManifest> {
  const info = await lstat(join(root, "manifest.json"));
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error("Unsafe or oversized backup manifest");
  const value = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as BackupManifest;
  if (![1, 2].includes(value?.version) || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !value.files || typeof value.files !== "object" || Array.isArray(value.files)
    || !Object.hasOwn(value.files, "state.sqlite") || Object.keys(value.files).length > 100000
    || Object.keys(value).some(key => !["version", "createdAt", "files", "directories", "executables"].includes(key))) throw new Error("Invalid backup manifest");
  if (value.version === 1 && (value.directories !== undefined || value.executables !== undefined)) throw new Error("Legacy backup cannot declare plugin assets");
  if (value.version === 2 && (!Array.isArray(value.directories) || !Array.isArray(value.executables) || value.directories.length > 10000
    || new Set(value.directories).size !== value.directories.length || new Set(value.executables).size !== value.executables.length)) throw new Error("Invalid backup directory or executable inventory");
  for (const [name, checksum] of Object.entries(value.files)) if (!safeBackupPath(name, value.version) || typeof checksum !== "string" || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error("Unsafe backup path or checksum");
  for (const name of value.directories ?? []) if (!safeBackupPath(name, 2, true) || Object.hasOwn(value.files, name)) throw new Error("Unsafe backup directory");
  for (const name of value.executables ?? []) if (!Object.hasOwn(value.files, name) || !safeBackupPath(name, 2) || !name.startsWith("plugin-")) throw new Error("Unsafe backup executable entry");
  return value;
}
function snapshotPins(db: Database): Map<string, AdapterPluginIdentity> {
  const pins = new Map<string, AdapterPluginIdentity>();
  const add = (identity: AdapterPluginIdentity) => {
    // Reuse persisted domain identity validation, without selecting or executing an adapter.
    validateDomainDescriptor({ id: "backup", version: "1", config: {}, plugin: identity, resources: [{ id: "backup", mode: "read" }], grants: [] });
    pins.set(pluginGenerationKey(identity), identity);
  };
  for (const row of db.query("SELECT value FROM runtime_records WHERE kind IN ('configuration','task-configuration')").iterate() as Iterable<{ value: string }>) {
    const value = JSON.parse(row.value); if (value.domain?.plugin) { validateDomainDescriptor(value.domain); add(value.domain.plugin); }
  }
  for (const row of db.query("SELECT value FROM application_records WHERE namespace='host.channel-bindings'").iterate() as Iterable<{ value: string }>) {
    const value = JSON.parse(row.value); if (!value.descriptor?.plugin) throw new Error("Backup channel binding is missing plugin identity"); add(value.descriptor.plugin);
  }
  if (pins.size > 4096) throw new Error("Backup pinned generation limit exceeded");
  return pins;
}
/** Reproduce the package identity using recorded executable flags, even on a host that cannot represent POSIX modes. */
async function archivedFingerprint(root: string, prefix: string, files: readonly string[], directories: readonly string[], executable: ReadonlySet<string>): Promise<string> {
  const tree = new Map<string, Array<{ name: string; directory: boolean }>>();
  const add = (path: string, directory: boolean) => {
    const relative = path.slice(prefix.length + 1), parts = relative.split("/"), name = parts.pop()!, parent = parts.join("/");
    let entries = tree.get(parent); if (!entries) { entries = []; tree.set(parent, entries); }
    entries.push({ name, directory });
  };
  for (const path of directories) if (path.startsWith(prefix + "/")) add(path, true);
  for (const path of files) if (path.startsWith(prefix + "/")) add(path, false);
  const hash = createHash("sha256");
  const visit = async (parent: string) => {
    for (const entry of (tree.get(parent) ?? []).sort((left, right) => left.name.localeCompare(right.name))) {
      if ([".git", ".tnb-provenance.json"].includes(entry.name)) continue;
      const relative = parent ? `${parent}/${entry.name}` : entry.name, path = `${prefix}/${relative}`;
      if (entry.directory) { hash.update(`d\0${relative}\0`); await visit(relative); }
      else { hash.update(`f\0${relative}\0${executable.has(path) ? "x" : "-"}\0`); hash.update(await readBackupFile(root, path)); hash.update("\0"); }
    }
  };
  await visit(""); return hash.digest("hex");
}

/** Material verification only. No package import, factory, migration, network or new approval. */
export async function inspectBackupEvidence(root: string, manifest: BackupManifest, bytes: number): Promise<BackupInspection> {
  const listedDirectories = new Set(manifest.directories ?? []), seenDirectories = new Set<string>();
  if (manifest.version === 2) {
    await walkPluginEvidence(root, async name => {
      if (!listedDirectories.has(name)) throw new Error("Backup plugin directory is not covered by manifest"); seenDirectories.add(name);
    }, async name => { if (!Object.hasOwn(manifest.files, name)) throw new Error("Backup plugin file is not covered by manifest"); });
    if (seenDirectories.size !== listedDirectories.size) throw new Error("Backup plugin directory is missing");
  }
  const db = new Database(join(root, "state.sqlite"), { readonly: true });
  let pins: Map<string, AdapterPluginIdentity>;
  try {
    if ((db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check !== "ok" || db.query("PRAGMA foreign_key_check").all().length) throw new Error("Backup database integrity failure");
    pins = snapshotPins(db);
    for (const row of db.query("SELECT DISTINCT task_id FROM runtime_records WHERE kind='message'").iterate() as Iterable<{ task_id: string }>) {
      if (!Object.hasOwn(manifest.files, `${row.task_id}/transcript.jsonl`)) throw new Error("Backup is missing a referenced transcript");
    }
    for (const row of db.query("SELECT record_id,task_id,json_extract(value,'$.state') AS state FROM runtime_records WHERE kind='operation'").iterate() as Iterable<{ record_id: string; task_id: string; state: string }>) {
      if (row.state !== "intended" && !Object.hasOwn(manifest.files, `${row.task_id}/operations/${row.record_id}.jsonl`)) throw new Error("Backup is missing a dispatched operation journal");
    }
  } finally { db.close(); if (process.platform === "win32") Bun.gc(true); }
  const issues: BackupInspection["compatibility"]["issues"] = [];
  const archived = new Set((manifest.directories ?? []).filter(name => /^plugin-generations\/[a-f0-9]{64}$/.test(name)).map(name => name.split("/")[1]!));
  if (manifest.version === 2) {
    const executable = new Set(manifest.executables ?? []), filesByGeneration = new Map<string, string[]>(), directoriesByGeneration = new Map<string, string[]>();
    const group = (names: string[], target: Map<string, string[]>) => {
      for (const name of names) if (name.startsWith("plugin-generations/")) { const key = name.split("/")[1]!; let entries = target.get(key); if (!entries) { entries = []; target.set(key, entries); } entries.push(name); }
    };
    group(Object.keys(manifest.files), filesByGeneration); group(manifest.directories ?? [], directoriesByGeneration);
    for (const key of pins.keys()) if (!archived.has(key)) throw new Error("Backup is missing a referenced plugin generation");
    for (const key of archived) {
      const name = `plugin-generations/${key}/generation.json`;
      if (!Object.hasOwn(manifest.files, name)) throw new Error("Backup plugin generation metadata is missing");
      const metadata = JSON.parse((await readBackupFile(root, name)).toString("utf8"));
      const identity = metadata.identity as AdapterPluginIdentity;
      validateDomainDescriptor({ id: "backup", version: "1", config: {}, plugin: identity, resources: [{ id: "backup", mode: "read" }], grants: [] });
      if (metadata.version !== 1 || pluginGenerationKey(identity) !== key || typeof metadata.origin !== "string"
        || metadata.origins !== undefined && (!Array.isArray(metadata.origins) || !metadata.origins.includes(metadata.origin) || metadata.origins.some((value: unknown) => typeof value !== "string" || !value))) throw new Error("Backup plugin generation metadata is invalid");
      const packageRoot = join(root, "plugin-generations", key, "package");
      if (await archivedFingerprint(root, `plugin-generations/${key}/package`, filesByGeneration.get(key) ?? [], directoriesByGeneration.get(key) ?? [], executable) !== identity.fingerprint) throw new Error("Backup plugin generation fingerprint mismatch");
      let modeMatches = true;
      for (const name of filesByGeneration.get(key) ?? []) if (name.startsWith(`plugin-generations/${key}/package/`)) {
        if (((await lstat(join(root, name))).mode & 0o111 ? true : false) !== executable.has(name)) { modeMatches = false; break; }
      }
      if (!modeMatches) issues.push({ code: "PLUGIN_EXECUTABLE_MODE", plugin: identity });
      const loaded = await loadPlugins([{ directory: join(root, "plugin-generations", key), source: "user" }]);
      const canonical = await realpath(packageRoot), plugin = loaded.plugins.find(item => item.root === canonical);
      if (!plugin || plugin.name !== identity.name || plugin.version !== identity.version) issues.push({ code: "PLUGIN_HOST_COMPATIBILITY", plugin: identity });
      const abiName = `plugin-generations/${key}/package/runtime.json`;
      if ([metadata.origin, ...(metadata.origins ?? [])].includes(`builtin:${identity.name}`)) {
        let compatible = false;
        if (Object.hasOwn(manifest.files, abiName)) {
          try {
            const abi = JSON.parse((await readBackupFile(root, abiName)).toString("utf8"));
            const expected = abi.protocol === "tnb.channel/v1" ? channelRecoveryABI() : builtinRecoveryABI();
            compatible = digestJson(abi) === digestJson(expected);
          } catch { /* A complete package can still require another recovery host/ABI. */ }
        }
        if (!compatible) issues.push({ code: "PLUGIN_RECOVERY_ABI", plugin: identity });
      }
    }
  } else issues.push({ code: "LEGACY_PLUGIN_ASSETS_NOT_COVERED" });
  return { version: manifest.version, createdAt: manifest.createdAt, integrity: "verified", files: Object.keys(manifest.files).length, bytes,
    plugins: { coverage: manifest.version === 2 ? "included" : "not-covered", pinnedGenerations: pins.size, archivedGenerations: archived.size,
      privateStateDirectories: (manifest.directories ?? []).filter(name => /^plugin-state\/[a-f0-9]{64}$/.test(name)).length },
    compatibility: { status: issues.length ? "review-required" : "compatible", issues },
    requirements: ["current-host-trust-and-approval", "original-installed-packages-and-origins", "host-configuration-and-credentials", "workspaces-and-external-services"] };
}
