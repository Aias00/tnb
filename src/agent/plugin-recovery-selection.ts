import { basename, resolve } from "node:path";
import { stat } from "node:fs/promises";
import type { AdapterPluginIdentity } from "./domain";
import type { AgentPluginOptions } from "./plugins";
import type { BuiltinGenerationAuthority } from "./builtin-generations";
import { readRetainedPlugin, pluginGenerationKey } from "./plugin-generations";
import type { PluginGenerationReference } from "./plugin-generations";
import type { ChannelGenerationReference } from "./channel-bindings";
import { loadPlugins, assertPluginContributionPath, type LoadedPlugin } from "../services/plugins/loader";
import { pluginGenerationTrusted } from "../services/plugins/trust";
import { isPluginFingerprintBlocked } from "../services/plugins/policy";
import { PluginRecoveryError } from "./plugin-recovery-error";

export type RecoveryReference = PluginGenerationReference | ChannelGenerationReference;
type Discovery = Awaited<ReturnType<typeof loadPlugins>>;
export function assertPluginRecoveryPolicy(options: AgentPluginOptions, identity: AdapterPluginIdentity): void {
  if (isPluginFingerprintBlocked(identity.fingerprint, options.blockedFingerprints)) throw new PluginRecoveryError("PLUGIN_FINGERPRINT_BLOCKED", "selection", "Plugin fingerprint is blocked by host policy");
}
function assertApproval(authority: BuiltinGenerationAuthority | undefined, identity: AdapterPluginIdentity): void {
  if (authority?.approved(identity)) return;
  const status = authority?.inspect?.(identity);
  const code = status === "missing" ? "PLUGIN_BUILTIN_APPROVAL_MISSING" : status === "abi-incompatible" ? "PLUGIN_BUILTIN_ABI_INCOMPATIBLE" : "PLUGIN_BUILTIN_APPROVAL_OR_ABI";
  throw new PluginRecoveryError(code, "approval", "Historical builtin has no matching host approval or recovery ABI");
}

/** The real loader and read-only preflight share the same historical selection rules. */
export async function resolveRetainedPlugin(options: AgentPluginOptions, historyRoot: string, identity: AdapterPluginIdentity, references: readonly RecoveryReference[], discovered: Discovery) {
  assertPluginRecoveryPolicy(options, identity);
  const installed = discovered.plugins.find(plugin => plugin.name.toLowerCase() === identity.name.toLowerCase());
  const retained = await readRetainedPlugin(historyRoot, identity);
  const builtin = !installed && retained.origins.includes(`builtin:${identity.name}`);
  if (builtin) {
    if (discovered.errors.some(error => basename(error.path).toLowerCase() === identity.name.toLowerCase())) throw new PluginRecoveryError("PLUGIN_INSTALLATION_UNAVAILABLE", "selection", "Installed plugin selection blocks historical builtin recovery");
    const selected = options.builtins?.find(item => item.identity.name === identity.name);
    if (!selected?.package || options.enabled?.[identity.name] === false || options.enabled?.[identity.name.toLowerCase()] === false) throw new PluginRecoveryError("PLUGIN_BUILTIN_NOT_SELECTED", "selection", "Historical builtin is disabled or not selected by this host");
    if (references.some(ref => "adapter" in ref && pluginGenerationKey(ref.plugin) === pluginGenerationKey(identity))) assertApproval(options.builtinAuthority, identity);
    if (references.some(ref => "channel" in ref && pluginGenerationKey(ref.plugin) === pluginGenerationKey(identity))) assertApproval(options.builtinChannelAuthority, identity);
  } else {
    if (!installed?.active) throw new PluginRecoveryError("PLUGIN_INSTALLATION_UNAVAILABLE", "selection", "Historical recovery requires the original plugin installation to remain enabled and trusted");
    if (!await pluginGenerationTrusted(options.trustStorePath, installed.root, identity.fingerprint)) throw new PluginRecoveryError("PLUGIN_GENERATION_UNTRUSTED", "approval", "Retained plugin generation is no longer trusted");
    if (!retained.origins.includes(installed.root)) throw new PluginRecoveryError("PLUGIN_INSTALLATION_ORIGIN_CHANGED", "selection", "Retained plugin installation origin changed");
  }
  return { ...retained, builtin, origin: builtin ? `builtin:${identity.name}` : installed!.root };
}

/** Static declarations and entry paths only. Factory registration is still checked during activation. */
export async function assertPinnedPluginContributions(plugin: LoadedPlugin, references: readonly RecoveryReference[], recoveryOnly: boolean): Promise<void> {
  for (const ref of references) {
    if (!ref.load) continue;
    const channel = "channel" in ref ? plugin.extensionContributions?.find(row => row.kind === "channel" && row.id === ref.channel.id && row.version === ref.channel.version) : undefined;
    const declaration = "adapter" in ref ? plugin.adapterContributions?.find(row => row.id === ref.adapter.id && row.version === ref.adapter.version)
      : channel;
    if (!declaration) throw new PluginRecoveryError("PLUGIN_CONTRIBUTION_MISSING", "contract", "Retained plugin does not provide the pinned contribution");
    if (recoveryOnly && channel?.requires.length) throw new PluginRecoveryError("PLUGIN_CHANNEL_DEPENDENCY_UNSUPPORTED", "contract", "Retained channels must be self-contained and have no contribution dependencies");
    try {
      const entry = await assertPluginContributionPath(plugin, resolve(plugin.root, declaration.entry));
      if (!(await stat(entry)).isFile()) throw new Error("Plugin entry must be a regular file");
    }
    catch { throw new PluginRecoveryError("PLUGIN_ENTRY_INVALID", "contract", "Pinned plugin entry is missing or unsafe"); }
  }
}
