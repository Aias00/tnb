import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { LoadedPlugin } from "./loader";
import type { PluginToolRuntimeManager } from "./tools";

export type PluginRuntimeState = {
  name: string;
  version?: string;
  status: "loaded" | "active" | "stopped" | "failed";
  updatedAt: string;
  sessionId: string;
  error?: string;
};

export class PluginLifecycleManager {
  #states = new Map<string, PluginRuntimeState>();

  constructor(
    private readonly path: string,
    private readonly sessionId: string,
    private readonly toolRuntime?: PluginToolRuntimeManager,
  ) {}

  async initialize(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (Array.isArray(value)) {
        for (const state of value) if (isPluginRuntimeState(state)) this.#states.set(state.name.toLowerCase(), state);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }
  }

  async start(plugins: readonly LoadedPlugin[]): Promise<void> {
    for (const plugin of plugins) {
      if (!plugin.active) {
        await this.#set(plugin, "loaded");
        continue;
      }
      try {
        await this.toolRuntime?.startEager([plugin]);
        await this.#set(plugin, "active");
      } catch (error) {
        await this.#set(plugin, "failed", error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
  }

  async activate(plugin: LoadedPlugin): Promise<void> {
    try {
      await this.toolRuntime?.startEager([plugin]);
      await this.#set(plugin, "active");
    } catch (error) {
      await this.#set(plugin, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async deactivate(plugin: LoadedPlugin): Promise<void> {
    await this.toolRuntime?.stopPlugin(plugin);
    await this.#set(plugin, "stopped");
  }

  isActive(plugin: LoadedPlugin): boolean {
    return this.#states.get(plugin.name.toLowerCase())?.status === "active";
  }

  async fail(plugin: LoadedPlugin, error: unknown): Promise<void> {
    await this.#set(plugin, "failed", error instanceof Error ? error.message : String(error));
  }

  async stop(plugins: readonly LoadedPlugin[], closeRuntime = true): Promise<void> {
    if (closeRuntime) await this.toolRuntime?.close();
    for (const plugin of plugins) await this.#set(plugin, "stopped");
  }

  list(): PluginRuntimeState[] {
    return [...this.#states.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async #set(plugin: LoadedPlugin, status: PluginRuntimeState["status"], error?: string): Promise<void> {
    this.#states.set(plugin.name.toLowerCase(), {
      name: plugin.name,
      ...(plugin.version ? { version: plugin.version } : {}),
      status,
      updatedAt: new Date().toISOString(),
      sessionId: this.sessionId,
      ...(error ? { error } : {}),
    });
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.list(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}

export function reconcilePluginCatalog(
  previous: readonly LoadedPlugin[],
  discovered: readonly LoadedPlugin[],
  forceRuntimeReload = false,
): {
  plugins: LoadedPlugin[];
  stop: LoadedPlugin[];
  deferred: Array<{ plugin: LoadedPlugin; policy: "session" | "restart" }>;
} {
  const previousByName = new Map(previous.map((plugin) => [plugin.name.toLowerCase(), plugin]));
  const discoveredByName = new Map(discovered.map((plugin) => [plugin.name.toLowerCase(), plugin]));
  const stop: LoadedPlugin[] = [];
  const deferred: Array<{ plugin: LoadedPlugin; policy: "session" | "restart" }> = [];
  const plugins: LoadedPlugin[] = [];
  for (const oldPlugin of previous) {
    const nextPlugin = discoveredByName.get(oldPlugin.name.toLowerCase());
    if (!nextPlugin) {
      stop.push(oldPlugin);
      continue;
    }
    previousByName.delete(oldPlugin.name.toLowerCase());
    discoveredByName.delete(oldPlugin.name.toLowerCase());
    const policy = strictestReloadPolicy(oldPlugin, nextPlugin);
    if (pluginFingerprint(oldPlugin) === pluginFingerprint(nextPlugin) && !(forceRuntimeReload && policy === "runtime")) {
      plugins.push(nextPlugin);
      continue;
    }
    if (policy === "runtime") {
      stop.push(oldPlugin);
      plugins.push(nextPlugin);
    } else {
      plugins.push(oldPlugin);
      deferred.push({ plugin: nextPlugin, policy });
    }
  }
  plugins.push(...discoveredByName.values());
  return { plugins, stop, deferred };
}

function strictestReloadPolicy(previous: LoadedPlugin, next: LoadedPlugin): "runtime" | "session" | "restart" {
  const policies = [
    previous.lifecycle.reload,
    next.lifecycle.reload,
    ...previous.toolContributions.map((tool) => tool.lifecycle.reload),
    ...next.toolContributions.map((tool) => tool.lifecycle.reload),
  ];
  if (policies.includes("restart")) return "restart";
  if (policies.includes("session")) return "session";
  return "runtime";
}

function pluginFingerprint(plugin: LoadedPlugin): string {
  return JSON.stringify({
    version: plugin.version,
    active: plugin.active,
    lifecycle: plugin.lifecycle,
    contributionSummary: plugin.contributionSummary,
    toolContributions: plugin.toolContributions,
  });
}

function isPluginRuntimeState(value: unknown): value is PluginRuntimeState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Partial<PluginRuntimeState>;
  return typeof state.name === "string" && typeof state.updatedAt === "string" && typeof state.sessionId === "string" &&
    (state.status === "loaded" || state.status === "active" || state.status === "stopped" || state.status === "failed");
}
