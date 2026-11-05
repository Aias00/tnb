import type { AdapterPluginIdentity } from "./domain";
import type { ChannelDescriptor, ChannelRegistry } from "./extensions";
import type { RuntimeStore } from "../services/runtime/store";
import { digestJson, text } from "../services/runtime/json";

export const CHANNEL_BINDINGS = "host.channel-bindings";
export type ChannelBinding = { owner: string; key: string; transport: string; descriptor: ChannelDescriptor & { plugin: AdapterPluginIdentity } };
export type ChannelGenerationReference = { plugin: AdapterPluginIdentity; channel: { id: string; version: string }; owner: string; key: string; load: boolean };
const bindingId = (owner: string, key: string) => digestJson({ owner, key });

export function readChannelBinding(store: RuntimeStore, owner: string, key: string): ChannelBinding | undefined {
  return store.applicationRecord<ChannelBinding>(CHANNEL_BINDINGS, bindingId(owner, key))?.value;
}
export function saveChannelBinding(store: RuntimeStore, binding: ChannelBinding): void {
  text(binding.owner, "channel binding owner", 128); text(binding.key, "channel binding key", 128);
  const id = bindingId(binding.owner, binding.key), previous = store.applicationRecord<ChannelBinding>(CHANNEL_BINDINGS, id);
  if (previous) { if (digestJson(previous.value) !== digestJson(binding)) throw new Error("Channel binding is immutable"); return; }
  store.command(`channel-bind:${id}`, binding, Date.now(), tx => tx.saveApplicationRecord({ namespace: CHANNEL_BINDINGS, id, value: binding }, 0));
}
export function resolveChannelBinding(store: RuntimeStore, owner: string, key: string, transport: string, requested: ChannelDescriptor, channels: ChannelRegistry): ChannelDescriptor {
  const previous = readChannelBinding(store, owner, key);
  if (previous) {
    if (previous.transport !== transport || previous.descriptor.id !== requested.id || previous.descriptor.version !== requested.version
      || requested.plugin && digestJson(requested.plugin) !== digestJson(previous.descriptor.plugin)) throw new Error("Source channel binding or transport changed; use a new Source ID");
    return channels.descriptor(previous.descriptor);
  }
  const descriptor = channels.descriptor(requested);
  if (!descriptor.plugin) throw new Error("Channel binding requires concrete plugin provenance");
  saveChannelBinding(store, { owner, key, transport, descriptor: { ...descriptor, plugin: descriptor.plugin } });
  return descriptor;
}
export function channelGenerationReferences(store: RuntimeStore, enabled?: (binding: ChannelBinding) => boolean): ChannelGenerationReference[] {
  const references: ChannelGenerationReference[] = []; let after = "";
  for (;;) {
    const page = store.applicationRecords<ChannelBinding>(CHANNEL_BINDINGS, after, 256);
    for (const { value } of page) references.push({ plugin: value.descriptor.plugin, channel: { id: value.descriptor.id, version: value.descriptor.version }, owner: value.owner, key: value.key, load: enabled?.(value) ?? true });
    if (page.length < 256) return references;
    after = page.at(-1)!.id;
  }
}
