import type { ChannelDescriptor, ChannelRegistry } from "../../agent/extensions";
import { channelGenerationReferences, readChannelBinding, resolveChannelBinding, saveChannelBinding } from "../../agent/channel-bindings";
import type { RuntimeStore } from "../runtime/store";
import { digestJson, text } from "../runtime/json";
import { sourceIdentity } from "./config";
import type { CollaborationConfig, Source } from "./types";

export const COLLABORATION_CHANNEL_OWNER = "tnb.collaboration/v1";
const legacyNamespace = `plugin:${digestJson({ plugin: "tnb-collaboration", kind: "application", id: "collaboration", version: "1" }).slice(0, 48)}`;
const migrationNamespace = "host.collab-channel-migration";
const requestedChannel = (source: Source): ChannelDescriptor => source.channel ?? { id: source.type, version: "1" };
const transport = (source: Source, descriptor: ChannelDescriptor) => sourceIdentity(source.type === "plugin" ? { ...source, channel: descriptor } : source);

/** One-time host-side adoption, before importing upgraded applications. No adapters or network run here. */
export function migrateCollaborationChannels(store: RuntimeStore): void {
  if (store.applicationRecord(migrationNamespace, "v1")) return;
  const unresolved: string[] = []; let after = "";
  for (;;) {
    const page = store.applicationRecords<{ descriptor?: ChannelDescriptor }>(legacyNamespace, after, 256);
    for (const row of page) {
      if (!row.id.startsWith("channel:")) continue;
      const sourceId = row.id.slice(8);
      if (readChannelBinding(store, COLLABORATION_CHANNEL_OWNER, sourceId)) continue;
      try {
        const descriptor = row.value.descriptor;
        if (!descriptor?.plugin || !/^[a-f0-9]{64}$/.test(descriptor.plugin.fingerprint)) throw new Error("Missing channel provenance");
        text(descriptor.id, "channel ID", 128); text(descriptor.version, "channel version", 128);
        text(descriptor.plugin.name, "channel plugin name", 64); text(descriptor.plugin.version, "channel plugin version", 128);
        const identity = store.applicationRecord<{ identity: string }>("collaboration.sources", sourceId)?.value.identity;
        if (!identity || !/^[a-f0-9]{64}$/.test(identity)) throw new Error("Legacy Source registration is incomplete");
        saveChannelBinding(store, { owner: COLLABORATION_CHANNEL_OWNER, key: sourceId, transport: identity, descriptor: { id: descriptor.id, version: descriptor.version,
          plugin: { name: descriptor.plugin.name, version: descriptor.plugin.version, fingerprint: descriptor.plugin.fingerprint } } });
      } catch { unresolved.push(sourceId); }
    }
    if (page.length < 256) break;
    after = page.at(-1)!.id;
  }
  store.command("collaboration-channel-migration:v1", { version: 1, unresolved }, Date.now(), tx => tx.saveApplicationRecord({ namespace: migrationNamespace, id: "v1", value: { unresolved } }, 0));
}
export function resolveCollaborationChannel(store: RuntimeStore, configuration: CollaborationConfig, channels: ChannelRegistry, sourceId: string): ChannelDescriptor {
  const source = configuration.enabled && configuration.sources.find(item => item.id === sourceId);
  if (!source) throw new Error("Collaboration Source is not enabled");
  const previous = readChannelBinding(store, COLLABORATION_CHANNEL_OWNER, sourceId);
  if (!previous && store.applicationRecord<{ unresolved: string[] }>(migrationNamespace, "v1")?.value.unresolved.includes(sourceId)) throw new Error("Legacy Source channel binding is incomplete; explicit migration or a new Source ID is required");
  const requested = requestedChannel(source), descriptor = previous?.descriptor ?? channels.descriptor(requested);
  return resolveChannelBinding(store, COLLABORATION_CHANNEL_OWNER, sourceId, transport(source, descriptor), requested, channels);
}
export function collaborationChannelReferences(store: RuntimeStore, configuration: CollaborationConfig) {
  return channelGenerationReferences(store, binding => {
    if (binding.owner !== COLLABORATION_CHANNEL_OWNER) return true;
    const source = configuration.enabled && configuration.sources.find(item => item.id === binding.key);
    if (!source) return false;
    const requested = requestedChannel(source);
    return requested.id === binding.descriptor.id && requested.version === binding.descriptor.version
      && (!requested.plugin || digestJson(requested.plugin) === digestJson(binding.descriptor.plugin)) && transport(source, binding.descriptor) === binding.transport;
  });
}
