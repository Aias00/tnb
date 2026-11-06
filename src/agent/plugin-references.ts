import type { AdapterPluginIdentity } from "./domain";
import type { PluginGenerationReference } from "./plugin-generations";
import { pluginGenerationKey } from "./plugin-generations";
import type { ChannelGenerationReference } from "./channel-bindings";
import type { HostPluginState } from "./plugins";

/** Omission means unknown, not an empty inventory. Supplied lists must be complete host facts. */
export type PluginReferenceInventory = {
  generationReferences?: readonly PluginGenerationReference[];
  channelReferences?: readonly ChannelGenerationReference[];
};
export type PluginCollectionState =
  | { phase: "startup"; status: "disabled"; reason: "no-history-root" | "incomplete-inventory" }
  | { phase: "startup"; status: "completed" }
  | { phase: "startup"; status: "failed"; error: string };
export type PluginRetentionReason =
  | { kind: "run" | "task"; runId: string; taskId?: string; adapter: { id: string; version: string }; load: boolean }
  | { kind: "channel"; owner: string; key: string; channel: { id: string; version: string }; load: boolean };
export type PluginReferenceReport = {
  version: 1;
  inventory: { domains: "complete" | "unknown"; channels: "complete" | "unknown" };
  collection: PluginCollectionState;
  generations: Array<{
    key: string;
    plugin: AdapterPluginIdentity;
    retain: true;
    load: boolean;
    references: PluginRetentionReason[];
    /** In-memory host state only; this is not an archive integrity or recovery check. */
    implementations: Array<Pick<HostPluginState, "generation" | "status" | "error">>;
  }>;
};

/** Read-only projection. Does not import, load, collect or validate any archived code. */
export function pluginReferenceReport(inventory: PluginReferenceInventory, states: readonly HostPluginState[], collection: PluginCollectionState): PluginReferenceReport {
  const generations = new Map<string, PluginReferenceReport["generations"][number]>();
  const add = (plugin: AdapterPluginIdentity, reason: PluginRetentionReason) => {
    const key = pluginGenerationKey(plugin);
    let generation = generations.get(key);
    if (!generation) {
      generation = { key, plugin, retain: true, load: false, references: [], implementations: states.filter(state => state.name === plugin.name && state.version === plugin.version && state.fingerprint === plugin.fingerprint)
        .map(({ generation, status, error }) => ({ generation, status, ...(error ? { error } : {}) })) };
      generations.set(key, generation);
    }
    generation.references.push(reason);
    generation.load ||= reason.load;
  };
  for (const ref of inventory.generationReferences ?? []) add(ref.plugin, { kind: ref.taskId ? "task" : "run", runId: ref.runId, ...(ref.taskId ? { taskId: ref.taskId } : {}), adapter: ref.adapter, load: ref.load });
  for (const ref of inventory.channelReferences ?? []) add(ref.plugin, { kind: "channel", owner: ref.owner, key: ref.key, channel: ref.channel, load: ref.load });
  return structuredClone({ version: 1, inventory: { domains: inventory.generationReferences === undefined ? "unknown" : "complete", channels: inventory.channelReferences === undefined ? "unknown" : "complete" },
    collection, generations: [...generations.values()].sort((a, b) => a.key.localeCompare(b.key)) });
}
