import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PluginRuntimeState } from "./lifecycle";
import { loadPlugins, type LoadedPlugin } from "./loader";

export type PluginRuntimeCacheSummary = {
  name: string;
  sessions: number;
  latest: PluginRuntimeState;
  states: PluginRuntimeState[];
  versions: string[];
};

export async function installLocalPlugin(options: {
  source: string;
  targetRoot: string;
  sourceType: LoadedPlugin["source"];
}): Promise<LoadedPlugin> {
  const source = await realpath(options.source);
  const info = await stat(source);
  if (!info.isDirectory()) throw new Error("Plugin install source must be a directory");
  const stageRoot = join(options.targetRoot, `.install-stage-${randomUUID()}`);
  const stagedPlugin = join(stageRoot, source.split("/").at(-1) ?? "plugin");
  await mkdir(stageRoot, { recursive: true });
  try {
    await cp(source, stagedPlugin, { recursive: true, errorOnExist: true });
    return await adoptStagedPlugin({
      stagedRoot: stagedPlugin,
      targetRoot: options.targetRoot,
      sourceType: options.sourceType,
    });
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function adoptStagedPlugin(options: {
  stagedRoot: string;
  targetRoot: string;
  sourceType: LoadedPlugin["source"];
  expectedName?: string;
  expectedVersion?: string;
}): Promise<LoadedPlugin> {
  const stagedRoot = await realpath(options.stagedRoot);
  const loaded = await loadPlugins([{ directory: dirname(stagedRoot), source: options.sourceType }]);
  const staged = loaded.plugins.find((plugin) => plugin.root === stagedRoot);
  if (!staged) throw new Error(loaded.errors[0]?.error ?? "staged directory has no valid plugin manifest");
  if (options.expectedName && staged.name.toLowerCase() !== options.expectedName.toLowerCase()) {
    throw new Error(`Expected plugin ${options.expectedName}, found ${staged.name}`);
  }
  if (options.expectedVersion && staged.version !== options.expectedVersion) {
    throw new Error(`Expected plugin ${staged.name}@${options.expectedVersion}, found ${staged.version ?? "unversioned"}`);
  }
  const target = join(options.targetRoot, staged.name);
  try {
    await stat(target);
    throw new Error(`Plugin already exists: ${staged.name}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await mkdir(options.targetRoot, { recursive: true });
  await rename(stagedRoot, target);
  await rm(dirname(stagedRoot), { recursive: true, force: true });
  const installed = await loadPlugins([{ directory: options.targetRoot, source: options.sourceType }], { [staged.name]: true });
  const plugin = installed.plugins.find((candidate) => candidate.name.toLowerCase() === staged.name.toLowerCase());
  if (!plugin) throw new Error(`Installed plugin could not be loaded: ${staged.name}`);
  return plugin;
}

export async function removeInstalledPlugin(options: {
  name: string;
  targetRoot: string;
  runtimeCacheRoot?: string;
}): Promise<{ target: string; trashed: string }> {
  const target = join(options.targetRoot, options.name);
  await stat(target);
  const trashRoot = join(options.targetRoot, ".removed");
  await mkdir(trashRoot, { recursive: true });
  const trashed = join(trashRoot, `${options.name}-${Date.now()}-${randomUUID()}`);
  await rename(target, trashed);
  if (options.runtimeCacheRoot) await prunePluginRuntimeCache(options.runtimeCacheRoot, options.name);
  return { target, trashed };
}

export async function loadPluginRuntimeCache(runtimeDir: string): Promise<Map<string, PluginRuntimeCacheSummary>> {
  const summaries = new Map<string, PluginRuntimeCacheSummary>();
  let entries;
  try {
    entries = await readdir(runtimeDir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return summaries;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    for (const state of await readRuntimeStateFile(join(runtimeDir, entry.name))) {
      const key = state.name.toLowerCase();
      const existing = summaries.get(key);
      const states = existing ? [...existing.states, state] : [state];
      states.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      summaries.set(key, {
        name: states[0]!.name,
        sessions: new Set(states.map((item) => item.sessionId)).size,
        latest: states[0]!,
        states,
        versions: [...new Set(states.map((item) => item.version).filter((item): item is string => Boolean(item)))],
      });
    }
  }
  return summaries;
}

export async function prunePluginRuntimeCache(runtimeDir: string, pluginName: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(runtimeDir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const needle = pluginName.toLowerCase();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(runtimeDir, entry.name);
    const states = await readRuntimeStateFile(path);
    const filtered = states.filter((state) => state.name.toLowerCase() !== needle);
    if (filtered.length === states.length) continue;
    if (!filtered.length) {
      await rm(path, { force: true });
      continue;
    }
    await writeJsonAtomic(path, filtered);
  }
}

async function readRuntimeStateFile(path: string): Promise<PluginRuntimeState[]> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (!Array.isArray(value)) return [];
  return value.filter(isPluginRuntimeState);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function isPluginRuntimeState(value: unknown): value is PluginRuntimeState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Partial<PluginRuntimeState>;
  return typeof state.name === "string" && typeof state.updatedAt === "string" && typeof state.sessionId === "string" &&
    (state.status === "loaded" || state.status === "active" || state.status === "stopped" || state.status === "failed");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
