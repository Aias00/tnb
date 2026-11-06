import { join } from "node:path";
import { loadPlugins, type LoadedPlugin } from "../plugins/loader";
import { applyPluginPolicy } from "../plugins/policy";
import { pluginTrustStorePath } from "../plugins/trust";
import { loadAgents } from "../agents/loader";
import { loadCommands } from "../commands/loader";
import { loadSkills } from "../skills/loader";
import { bundledSkills } from "../skills/bundled";

export function loadConfiguredPlugins(configDir: string, cwd: string, enabled: Record<string, boolean> | undefined, blockedFingerprints?: readonly string[]) {
  return loadPlugins([
    { directory: join(configDir, "plugins"), source: "user" },
    { directory: join(cwd, ".tnb", "plugins"), source: "project" },
  ], enabled, { trustStorePath: pluginTrustStorePath(configDir), blockedFingerprints });
}

export function selectExecutionPlugins(options: { configDir: string; cwd: string; enabled?: Record<string, boolean>; blockedFingerprints?: readonly string[]; catalog?: readonly LoadedPlugin[] }) {
  if (!options.catalog) return loadConfiguredPlugins(options.configDir, options.cwd, options.enabled, options.blockedFingerprints);
  return Promise.resolve({ plugins: options.catalog.map(plugin => applyPluginPolicy(plugin, options)), errors: [] });
}

type ResourceOptions = { configDir: string; cwd: string; plugins: readonly LoadedPlugin[] };
export function loadExecutionAgents({ configDir, cwd, plugins }: ResourceOptions) {
  return loadAgents([
    { directory: join(configDir, "agents"), source: "user" },
    { directory: join(cwd, ".claude", "agents"), source: "claude-project" },
    { directory: join(cwd, ".tnb", "agents"), source: "project" },
    ...plugins.filter(plugin => plugin.active).map(plugin => ({ directory: plugin.agentsDir, source: "plugin" as const })),
  ]);
}
export function loadExecutionCommands({ configDir, cwd, plugins }: ResourceOptions) {
  return loadCommands([
    { directory: join(configDir, "commands"), source: "user" },
    { directory: join(cwd, ".claude", "commands"), source: "compat-project" },
    { directory: join(cwd, ".tnb", "commands"), source: "project" },
    ...plugins.filter(plugin => plugin.active).map(plugin => ({ directory: plugin.commandsDir, source: "plugin" as const })),
  ]);
}
export function loadExecutionSkills({ configDir, cwd, plugins }: ResourceOptions) {
  return loadSkills([
    { directory: join(configDir, "skills"), source: "user" },
    { directory: join(cwd, ".tnb", "skills"), source: "project" },
    ...plugins.filter(plugin => plugin.active).map(plugin => ({ directory: plugin.skillsDir, source: "plugin" as const })),
  ], bundledSkills());
}

/** Discovery only: no factories, hooks, transports, or tool processes are started. */
export async function loadExecutionResources(options: Parameters<typeof selectExecutionPlugins>[0]) {
  const { plugins } = await selectExecutionPlugins(options);
  const input = { ...options, plugins };
  const [agents, commands, skills] = await Promise.all([loadExecutionAgents(input), loadExecutionCommands(input), loadExecutionSkills(input)]);
  return { plugins, agents, commands, skills, signature: JSON.stringify({ plugins, agents, commands, skills }) };
}
