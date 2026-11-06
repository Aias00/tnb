import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalPluginToolContribution, LoadedPlugin } from "./loader";
import { digestJson, encodeJson } from "../runtime/json";

export type PluginToolEnvironmentGrant = { plugin: string; fingerprint: string; tool: string; variables: Record<string, string> };
export class PluginToolEnvironmentError extends Error {
  constructor(readonly code: "PLUGIN_TOOL_ENVIRONMENT_INVALID" | "PLUGIN_TOOL_ENVIRONMENT_DENIED" | "PLUGIN_TOOL_ENVIRONMENT_CHANGED", detail: string) {
    super(`${code}: ${detail}`); this.name = "PluginToolEnvironmentError";
  }
}
const reserved = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMP", "TEMP", "TMPDIR", "SHELL", "ENV", "BASH_ENV", "ZDOTDIR", "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS", "BUN_INSTALL", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_SSH", "GIT_SSH_COMMAND"]);
const variable = (name: unknown): name is string => typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name);
export function parsePluginToolEnvironment(input: unknown): PluginToolEnvironmentGrant[] {
  const fail = (): never => { throw new PluginToolEnvironmentError("PLUGIN_TOOL_ENVIRONMENT_INVALID", "Expected bounded host grants with package fingerprint, tool ID and environment references"); };
  if (!Array.isArray(input) || input.length > 128) return fail();
  const seen = new Set<string>();
  for (const grant of input) {
    if (!grant || typeof grant !== "object" || Array.isArray(grant) || Object.keys(grant).some(key => !["plugin", "fingerprint", "tool", "variables"].includes(key))
      || typeof grant.plugin !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(grant.plugin) || typeof grant.tool !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(grant.tool)
      || typeof grant.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(grant.fingerprint) || !grant.variables || typeof grant.variables !== "object" || Array.isArray(grant.variables)
      || Object.keys(grant.variables).length > 32) return fail();
    const key = `${grant.plugin.toLowerCase()}\0${grant.tool}`;
    if (seen.has(key)) return fail(); seen.add(key);
    const targets = new Set<string>();
    for (const [name, source] of Object.entries(grant.variables)) {
      const upper = name.toUpperCase();
      if (!variable(name) || !variable(source) || reserved.has(upper) || /^(LD_|DYLD_|BUN_CONFIG_)/.test(upper) || upper.endsWith("_PROXY") || targets.has(upper)) return fail();
      targets.add(upper);
    }
  }
  try {
    const result = JSON.parse(encodeJson(input, 128 * 1024)) as PluginToolEnvironmentGrant[];
    return result.map(grant => ({ ...grant, plugin: grant.plugin.toLowerCase() })).sort((a, b) => `${a.plugin}\0${a.tool}`.localeCompare(`${b.plugin}\0${b.tool}`));
  } catch { return fail(); }
}
export const pluginEnvironmentGeneration = (plugin: LoadedPlugin) => JSON.stringify([plugin.root, plugin.fingerprint ?? null]);
type Binding = { identity: string; secrets: string[]; variables: Record<string, string> };
type PrivateEnvironment = { directory: string; env: Record<string, string> };

/** Environment hygiene only. Trusted child code still has its ordinary OS file/network access. */
export class PluginToolEnvironments {
  private grants: PluginToolEnvironmentGrant[];
  readonly #source: Readonly<Record<string, string | undefined>>;
  private readonly homes = new Map<string, { generation: string; value: Promise<PrivateEnvironment> }>();
  constructor(source: Record<string, string | undefined>, grants: readonly PluginToolEnvironmentGrant[] = [], private readonly maximum = 128) {
    this.#source = Object.freeze(Object.assign(Object.create(null), source)); this.grants = parsePluginToolEnvironment(grants);
  }
  policyIdentity() { return digestJson(this.grants); }
  replace(grants: PluginToolEnvironmentGrant[]) { this.grants = structuredClone(grants); }
  bind(plugin: LoadedPlugin, tool: ExternalPluginToolContribution): Binding {
    const grant = this.grants.find(item => item.plugin.toLowerCase() === plugin.name.toLowerCase() && item.tool === tool.id);
    if (grant && (grant.fingerprint !== plugin.fingerprint || tool.lifecycle.transport === "http")) throw new PluginToolEnvironmentError("PLUGIN_TOOL_ENVIRONMENT_DENIED", "Environment grant does not match this process tool's package fingerprint");
    const variables: Record<string, string> = Object.create(null), secrets: string[] = []; let size = 0;
    for (const [target, source] of Object.entries(grant?.variables ?? {})) {
      const name = process.platform === "win32" ? Object.keys(this.#source).find(name => name.toUpperCase() === source.toUpperCase()) : source;
      const value = name ? this.#source[name] : undefined;
      if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > 16 * 1024 || (size += Buffer.byteLength(value)) > 32 * 1024) throw new PluginToolEnvironmentError("PLUGIN_TOOL_ENVIRONMENT_DENIED", "A required host environment reference is missing, invalid or oversized");
      variables[target] = value; secrets.push(value);
    }
    return { identity: digestJson(grant ?? null), variables, secrets };
  }
  async prepare(plugin: LoadedPlugin, tool: ExternalPluginToolContribution, binding: Binding): Promise<Record<string, string>> {
    const generation = pluginEnvironmentGeneration(plugin), key = JSON.stringify([generation, tool.id, binding.identity]);
    let pending = this.homes.get(key);
    if (!pending) {
      if (this.homes.size >= this.maximum) throw new PluginToolEnvironmentError("PLUGIN_TOOL_ENVIRONMENT_DENIED", "Private process environment limit reached");
      const value = this.create(binding).catch(error => { this.homes.delete(key); throw error; });
      pending = { generation, value }; this.homes.set(key, pending);
    }
    return { ...(await pending.value).env };
  }
  private async create(binding: Binding): Promise<PrivateEnvironment> {
    const directory = await mkdtemp(join(tmpdir(), "tnb-plugin-env-"));
    try {
      const home = join(directory, "home"), temporary = join(directory, "tmp");
      await mkdir(home, { mode: 0o700 }); await mkdir(temporary, { mode: 0o700 });
      const env: Record<string, string> = Object.create(null);
      for (const name of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "LANG", "LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES", "LC_NUMERIC", "LC_TIME", "TZ", "TERM", "NO_COLOR", "FORCE_COLOR"]) {
        const key = process.platform === "win32" ? Object.keys(this.#source).find(key => key.toUpperCase() === name.toUpperCase()) : name;
        const value = key ? this.#source[key] : undefined;
        if (typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value) <= 32 * 1024) env[name] = value;
      }
      env.PATH ??= process.platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/bin:/bin:/usr/sbin:/sbin";
      if (process.platform === "win32") env.SystemRoot ??= process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
      Object.assign(env, { HOME: home, USERPROFILE: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary }, binding.variables);
      for (const [name, leaf] of Object.entries({ XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_DATA_HOME: "data", XDG_STATE_HOME: "state", APPDATA: "roaming", LOCALAPPDATA: "local" })) {
        env[name] = join(home, leaf); await mkdir(env[name], { mode: 0o700 });
      }
      return { directory, env };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  async clear(generation?: string): Promise<void> {
    const selected = [...this.homes.entries()].filter(([, entry]) => generation === undefined || entry.generation === generation);
    const results = await Promise.allSettled(selected.map(async ([key, entry]) => {
      const value = await entry.value; await rm(value.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); this.homes.delete(key);
    }));
    const errors = results.filter(item => item.status === "rejected").map(item => item.reason);
    if (errors.length) throw new AggregateError(errors, "Plugin private environment cleanup failed");
  }
}

export function redactPluginCredentials(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const value of secrets) { result = result.split(value).join("[redacted]"); if (result.length > 100000) result = result.slice(0, 100000) + "\n… plugin tool output truncated"; }
  return result;
}
export function redactPluginError(error: unknown, secrets: readonly string[]): unknown {
  if (!(error instanceof Error)) return new Error(redactPluginCredentials(String(error), secrets));
  if (error instanceof AggregateError) return new AggregateError([...error.errors].map(error => redactPluginError(error, secrets)), redactPluginCredentials(error.message, secrets));
  const message = redactPluginCredentials(error.message, secrets);
  return message === error.message ? error : new Error(message); // Never retain a raw-secret cause or stack.
}
