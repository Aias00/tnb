import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeStore } from "../services/runtime/store";
import { digestJson } from "../services/runtime/json";
import { computePluginTreeSha256 } from "../services/plugins/trust";
import { loadPlugins, type LoadedPlugin } from "../services/plugins/loader";
import { validateDomainDescriptor, type AdapterPluginIdentity, type DomainDescriptor } from "./domain";

export type PluginGenerationReference = { plugin: AdapterPluginIdentity; adapter: { id: string; version: string }; runId: string; taskId?: string; load: boolean };
type GenerationMetadata = { version: 1; identity: AdapterPluginIdentity; origin: string };
export const pluginGenerationKey = (identity: AdapterPluginIdentity) => digestJson(identity);

/** Host facts only. Terminal evidence pins its bytes until explicit Run pruning. */
export function pluginGenerationReferences(store: RuntimeStore): PluginGenerationReference[] {
  const result: PluginGenerationReference[] = [];
  for (const run of store.runs()) {
    const add = (value: { domain?: DomainDescriptor } | undefined, taskId?: string) => {
      if (!value?.domain?.plugin) return;
      const { plugin, id, version } = validateDomainDescriptor(value.domain);
      result.push({ plugin: plugin!, adapter: { id, version }, runId: run.runId, ...(taskId ? { taskId } : {}), load: !["succeeded", "failed", "cancelled"].includes(run.status) });
    };
    add(store.record<{ domain?: DomainDescriptor }>("configuration", run.runId)?.value);
    for (const record of store.records<{ domain?: DomainDescriptor }>("task-configuration", run.runId)) add(record.value, record.taskId);
  }
  return result;
}

export async function retainPluginGeneration(root: string, identity: AdapterPluginIdentity, origin: string, packageRoot: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertHistoryRoot(root);
  const target = join(root, pluginGenerationKey(identity));
  try {
    const existing = await readRetainedPlugin(root, identity);
    if (existing.origin !== origin) throw new Error("Retained plugin origin changed");
    return;
  } catch (error) {
    if (!missing(error)) throw error; // Never overwrite corrupted historical evidence.
    try { await lstat(target); throw new Error("Retained plugin generation is incomplete"); } catch (entryError) { if (!missing(entryError)) throw entryError; }
  }
  const stage = await mkdtemp(join(root, ".stage-"));
  try {
    await cp(packageRoot, join(stage, "package"), { recursive: true, verbatimSymlinks: true });
    if (await computePluginTreeSha256(join(stage, "package")) !== identity.fingerprint) throw new Error("Plugin content changed during retention");
    await writeFile(join(stage, "generation.json"), JSON.stringify({ version: 1, identity, origin } satisfies GenerationMetadata), { mode: 0o600 });
    await syncTree(stage);
    await rename(stage, target);
    await syncDirectory(root); await syncDirectory(dirname(root));
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not expose directory fsync through Node; file flushes still precede rename.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); }
}
async function syncTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await syncTree(path);
    else if (entry.isFile()) {
      // Windows FlushFileBuffers requires a writable handle; POSIX permits read-only fsync.
      const handle = await open(path, process.platform === "win32" ? "r+" : "r");
      try { await handle.sync(); } finally { await handle.close(); }
    }
  }
  await syncDirectory(directory);
}

/** Revalidate both package bytes and current host compatibility before any import. */
export async function readRetainedPlugin(root: string, identity: AdapterPluginIdentity): Promise<{ plugin: LoadedPlugin; origin: string }> {
  await assertHistoryRoot(root);
  const directory = join(root, pluginGenerationKey(identity));
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Retained plugin directory cannot be a symbolic link");
  if ((await lstat(join(directory, "generation.json"))).isSymbolicLink()) throw new Error("Retained plugin metadata cannot be a symbolic link");
  const metadata: GenerationMetadata = JSON.parse(await readFile(join(directory, "generation.json"), "utf8"));
  if (metadata.version !== 1 || digestJson(metadata.identity) !== digestJson(identity) || typeof metadata.origin !== "string") throw new Error("Retained plugin metadata does not match pinned identity");
  const packageRoot = join(directory, "package");
  if ((await lstat(packageRoot)).isSymbolicLink()) throw new Error("Retained plugin package cannot be a symbolic link");
  if (await computePluginTreeSha256(packageRoot) !== identity.fingerprint) throw new Error("Retained plugin fingerprint mismatch");
  const loaded = await loadPlugins([{ directory, source: "user" }]);
  const canonicalRoot = await realpath(packageRoot);
  const plugin = loaded.plugins.find(item => item.root === canonicalRoot);
  if (!plugin || plugin.name !== identity.name || plugin.version !== identity.version) throw new Error(loaded.errors[0]?.error ?? "Retained plugin manifest does not match pinned identity");
  return { plugin: { ...plugin, fingerprint: identity.fingerprint }, origin: metadata.origin };
}

/** Only under owner lock, with a complete reference inventory supplied by the host. */
export async function collectPluginGenerations(root: string, keep: ReadonlySet<string>): Promise<void> {
  let entries;
  try { await assertHistoryRoot(root); entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (missing(error)) return; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !(entry.name.startsWith(".stage-") || /^[a-f0-9]{64}$/.test(entry.name) && !keep.has(entry.name))) continue;
    await rm(join(root, entry.name), { recursive: true, force: true });
  }
}

async function assertHistoryRoot(root: string): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Plugin history must be a real directory");
}
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
