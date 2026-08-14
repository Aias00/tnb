import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { loadPlugins, type LoadedPlugin } from "./loader";
import { adoptStagedPlugin } from "./management";
import { computePluginTreeSha256 } from "./trust";

export { computePluginTreeSha256 } from "./trust";

export type MarketplacePlugin = {
  name: string;
  version: string;
  description?: string;
  whenToUse?: string;
  tags?: string[];
  capabilities?: string[];
  documentationUrl?: string;
  repository: string;
  ref?: string;
  commit?: string;
  manifestSha256?: string;
  treeSha256?: string;
  marketplace: string;
};

type MarketplaceDocument = {
  name?: string;
  plugins?: unknown;
};

export async function loadPluginMarketplace(
  sources: string[],
  signal?: AbortSignal,
): Promise<{ plugins: MarketplacePlugin[]; errors: Array<{ source: string; error: string }> }> {
  const plugins = new Map<string, MarketplacePlugin>();
  const errors: Array<{ source: string; error: string }> = [];
  for (const source of sources) {
    try {
      const document = await readMarketplace(source, signal);
      const marketplace = document.name?.trim() || source;
      if (!Array.isArray(document.plugins)) throw new Error("marketplace plugins must be an array");
      for (const value of document.plugins) {
        const plugin = parseMarketplacePlugin(value, marketplace);
        if (!plugins.has(plugin.name.toLowerCase())) plugins.set(plugin.name.toLowerCase(), plugin);
      }
    } catch (error) {
      errors.push({ source, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { plugins: [...plugins.values()], errors };
}

export async function installMarketplacePlugin(options: {
  plugin: MarketplacePlugin;
  targetRoot: string;
  sourceType?: LoadedPlugin["source"];
  signal?: AbortSignal;
}): Promise<LoadedPlugin> {
  const temporary = join(options.targetRoot, `.install-${options.plugin.name}-${randomUUID()}`);
  await mkdir(options.targetRoot, { recursive: true });
  const args = ["git", "clone", "--depth", "1"];
  if (options.plugin.ref) args.push("--branch", options.plugin.ref);
  args.push("--", options.plugin.repository, temporary);
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", ...(options.signal ? { signal: options.signal } : {}) });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) {
    await rm(temporary, { recursive: true, force: true });
    throw new Error(`Plugin clone failed (${exitCode}): ${stderr.trim().slice(0, 1000)}`);
  }
  try {
    await verifyMarketplaceCheckout(temporary, options.plugin);
    return await adoptStagedPlugin({
      stagedRoot: temporary,
      targetRoot: options.targetRoot,
      sourceType: options.sourceType ?? "user",
      expectedName: options.plugin.name,
      expectedVersion: options.plugin.version,
    });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function updateMarketplacePlugin(options: {
  plugin: MarketplacePlugin;
  targetRoot: string;
  sourceType?: LoadedPlugin["source"];
  signal?: AbortSignal;
}): Promise<{ plugin: LoadedPlugin; previousVersion?: string }> {
  const target = join(options.targetRoot, options.plugin.name);
  const existing = await loadPlugins([{ directory: options.targetRoot, source: options.sourceType ?? "user" }]);
  const installed = existing.plugins.find((plugin) => plugin.name.toLowerCase() === options.plugin.name.toLowerCase());
  if (!installed) throw new Error(`Plugin is not installed: ${options.plugin.name}`);
  const stagedRoot = join(options.targetRoot, `.update-stage-${options.plugin.name}-${randomUUID()}`);
  const backup = join(options.targetRoot, `.update-backup-${options.plugin.name}-${randomUUID()}`);
  await installMarketplacePlugin({
    plugin: options.plugin,
    targetRoot: stagedRoot,
    sourceType: installed.source,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const staged = join(stagedRoot, options.plugin.name);
  let swapped = false;
  try {
    await rename(target, backup);
    try {
      await rename(staged, target);
      swapped = true;
    } catch (error) {
      await rename(backup, target);
      throw error;
    }
    const loaded = await loadPlugins([{ directory: options.targetRoot, source: installed.source }], { [options.plugin.name]: true });
    const plugin = loaded.plugins.find((candidate) => candidate.name.toLowerCase() === options.plugin.name.toLowerCase());
    if (!plugin) throw new Error(loaded.errors[0]?.error ?? `Updated plugin could not be loaded: ${options.plugin.name}`);
    await rm(backup, { recursive: true, force: true });
    await rm(stagedRoot, { recursive: true, force: true });
    return { plugin, ...(installed.version ? { previousVersion: installed.version } : {}) };
  } catch (error) {
    if (swapped) {
      await rm(target, { recursive: true, force: true });
      await rename(backup, target).catch(() => undefined);
    }
    await rm(stagedRoot, { recursive: true, force: true });
    if (!swapped) await rm(backup, { recursive: true, force: true });
    throw error;
  }
}

export async function configuredMarketplaceSources(configDir: string, env: Record<string, string | undefined>): Promise<string[]> {
  const explicit = env.TNB_PLUGIN_MARKETPLACE?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  let configured: string[] = [];
  try {
    const value: unknown = JSON.parse(await readFile(join(configDir, "marketplaces.json"), "utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const sources = (value as { sources?: unknown }).sources;
      if (Array.isArray(sources) && sources.every((item) => typeof item === "string" && item.trim())) {
        configured = sources.map((item) => (item as string).trim());
      }
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  }
  return [...new Set([...explicit, ...configured])];
}

async function readMarketplace(source: string, signal?: AbortSignal): Promise<MarketplaceDocument> {
  const text = /^https?:\/\//.test(source)
    ? await fetchMarketplace(source, signal)
    : await readFile(resolve(source), "utf8");
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("marketplace document must be an object");
  return value as MarketplaceDocument;
}

async function fetchMarketplace(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`marketplace request failed (${response.status})`);
  return response.text();
}

function parseMarketplacePlugin(value: unknown, marketplace: string): MarketplacePlugin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("marketplace plugin must be an object");
  const record = value as Record<string, unknown>;
  const name = requiredString(record.name, "name");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error(`invalid marketplace plugin name: ${name}`);
  const version = requiredString(record.version, `${name}.version`);
  const repository = requiredString(record.repository, `${name}.repository`);
  if (!/^(?:https?:\/\/|ssh:\/\/|git@|file:\/\/|\/)/.test(repository)) {
    throw new Error(`${name}.repository must be an absolute Git repository URL or path`);
  }
  const remote = /^(?:https?:\/\/|ssh:\/\/|git@)/.test(repository);
  if (/^http:\/\//.test(repository) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/.test(repository)) {
    throw new Error(`${name}.repository must use HTTPS or SSH`);
  }
  const commit = optionalHash(record.commit, `${name}.commit`, 40, 64);
  if (remote && !commit) throw new Error(`${name}.commit is required for remote repositories`);
  const manifestSha256 = optionalHash(record.manifestSha256, `${name}.manifestSha256`, 64);
  const treeSha256 = optionalHash(record.treeSha256, `${name}.treeSha256`, 64);
  return {
    name,
    version,
    repository,
    marketplace,
    ...(typeof record.description === "string" && record.description.trim() ? { description: record.description.trim() } : {}),
    ...(typeof record.whenToUse === "string" && record.whenToUse.trim() ? { whenToUse: record.whenToUse.trim() } : {}),
    ...(stringArray(record.tags)?.length ? { tags: stringArray(record.tags) } : {}),
    ...(stringArray(record.capabilities)?.length ? { capabilities: stringArray(record.capabilities) } : {}),
    ...(typeof record.documentationUrl === "string" && record.documentationUrl.trim()
      ? { documentationUrl: absoluteHttpUrl(record.documentationUrl.trim(), `${name}.documentationUrl`) }
      : {}),
    ...(typeof record.ref === "string" && record.ref.trim() ? { ref: record.ref.trim() } : {}),
    ...(commit ? { commit } : {}),
    ...(manifestSha256 ? { manifestSha256 } : {}),
    ...(treeSha256 ? { treeSha256 } : {}),
  };
}

async function verifyMarketplaceCheckout(root: string, plugin: MarketplacePlugin): Promise<void> {
  if (plugin.commit) {
    const actual = (await gitOutput(["-C", root, "rev-parse", "HEAD"])).trim().toLowerCase();
    if (actual !== plugin.commit.toLowerCase()) {
      throw new Error(`Plugin ${plugin.name} commit mismatch: expected ${plugin.commit}, received ${actual}`);
    }
  }
  if (plugin.manifestSha256) {
    let manifest: Uint8Array | undefined;
    for (const path of [join(root, ".tnb-plugin", "plugin.json"), join(root, "plugin.json")]) {
      try {
        manifest = new Uint8Array(await readFile(path));
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
      }
    }
    if (!manifest) throw new Error(`Plugin ${plugin.name} has no manifest to verify`);
    const actual = createHash("sha256").update(manifest).digest("hex");
    if (actual !== plugin.manifestSha256.toLowerCase()) {
      throw new Error(`Plugin ${plugin.name} manifest checksum mismatch`);
    }
  }
  if (plugin.treeSha256) {
    const actual = await computePluginTreeSha256(root);
    if (actual !== plugin.treeSha256.toLowerCase()) {
      throw new Error(`Plugin ${plugin.name} content checksum mismatch`);
    }
  }
}

async function gitOutput(args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Git verification failed (${exitCode}): ${stderr.trim().slice(0, 1000)}`);
  return stdout;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`marketplace ${field} must be a non-empty string`);
  return value.trim();
}

function optionalHash(value: unknown, field: string, ...lengths: number[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !lengths.some((length) => new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value))) {
    throw new Error(`marketplace ${field} must be ${lengths.join(" or ")} hexadecimal characters`);
  }
  return value.toLowerCase();
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) return undefined;
  return value.map((item) => item.trim());
}

function absoluteHttpUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`marketplace ${field} must be an absolute http or https URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`marketplace ${field} must be an absolute http or https URL`);
  }
  return url.toString();
}
