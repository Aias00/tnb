import { expect, test } from "bun:test";
import { RuntimeStore } from "../../src/services/runtime/store";
import { digestJson } from "../../src/services/runtime/json";
import { sourceIdentity } from "../../src/services/collaboration/config";
import { migrateCollaborationChannels, resolveCollaborationChannel, collaborationChannelReferences, COLLABORATION_CHANNEL_OWNER } from "../../src/services/collaboration/channels";
import { readChannelBinding } from "../../src/agent/channel-bindings";
import type { ChannelDescriptor, ChannelRegistry } from "../../src/agent/extensions";
import type { CollaborationConfig, Source } from "../../src/services/collaboration/types";

const legacy = `plugin:${digestJson({ plugin: "tnb-collaboration", kind: "application", id: "collaboration", version: "1" }).slice(0, 48)}`;
const identity = (fingerprint: string) => ({ name: "channels", version: "1.0.0", fingerprint: fingerprint.repeat(64) });
const old = { id: "webhook", version: "1", plugin: identity("a") }, current = { ...old, plugin: identity("b") };
const config = (type: Source["type"] = "webhook"): CollaborationConfig => ({ enabled: true, sources: [{ id: "chat", type, actors: ["alice"], controllers: ["alice"], mode: "single", pollIntervalMs: 1000,
  configuration: { workspace: "/work", allowedWorkspaces: ["/work"], allowWrite: false, allowShell: false, checks: [], maxTurns: 10, maxRetries: 1, compactThreshold: 10000 },
  ...(type === "plugin" ? { channel: { id: "webhook", version: "1" }, options: { destination: "original" } } : { webhook: { secretEnv: "SECRET", outboundUrl: "http://127.0.0.1/notify" } }) }] });
function registry(): ChannelRegistry {
  return { descriptor(input) {
    if (!input.plugin) return structuredClone(current);
    if (digestJson(input) !== digestJson(old) && digestJson(input) !== digestJson(current)) throw new Error("Unavailable"); return structuredClone(input);
  }, async connect(): Promise<never> { throw new Error("Migration must never connect a channel"); } };
}
function saveLegacy(store: RuntimeStore, source: Source, descriptor: ChannelDescriptor, complete = true) {
  store.command(`legacy:${source.id}`, { source, descriptor }, Date.now(), tx => {
    tx.saveApplicationRecord({ namespace: legacy, id: `channel:${source.id}`, value: { descriptor } }, 0);
    if (complete) tx.saveApplicationRecord({ namespace: "collaboration.sources", id: source.id, value: { identity: sourceIdentity(source.type === "plugin" ? { ...source, channel: descriptor } : source) } }, 0);
    return true;
  });
}

test("legacy Source channel pins migrate once, preserve the old implementation and reject transport changes", () => {
  for (const type of ["webhook", "plugin"] as const) {
    const store = new RuntimeStore(":memory:");
    try {
      const configuration = config(type); saveLegacy(store, configuration.sources[0]!, old); migrateCollaborationChannels(store);
      expect(resolveCollaborationChannel(store, configuration, registry(), "chat")).toEqual(old);
      expect(collaborationChannelReferences(store, configuration)[0]).toMatchObject({ channel: { id: "webhook", version: "1" }, plugin: old.plugin, load: true });
      const changed = structuredClone(configuration);
      if (type === "plugin") changed.sources[0]!.options = { destination: "changed" }; else changed.sources[0]!.webhook!.outboundUrl = "http://127.0.0.1/other";
      expect(() => resolveCollaborationChannel(store, changed, registry(), "chat")).toThrow("transport changed");
      expect(collaborationChannelReferences(store, changed)[0]!.load).toBe(false);
      expect(collaborationChannelReferences(store, { enabled: false, sources: [] })[0]!.load).toBe(false);
      store.command("rewrite-plugin-history", {}, Date.now(), tx => {
        const row = tx.applicationRecord(legacy, "channel:chat")!; tx.saveApplicationRecord({ ...row, value: { descriptor: current } }, row.revision); return true;
      }); migrateCollaborationChannels(store);
      expect(resolveCollaborationChannel(store, configuration, registry(), "chat")).toEqual(old);
      expect(readChannelBinding(store, COLLABORATION_CHANNEL_OWNER, "chat")!.descriptor).toEqual(old);
    } finally { store.close(); }
  }
});

test("plugin-written fake history after migration cannot select an old generation for a new Source", () => {
  const store = new RuntimeStore(":memory:");
  try {
    migrateCollaborationChannels(store); const configuration = config(); saveLegacy(store, configuration.sources[0]!, old);
    expect(resolveCollaborationChannel(store, configuration, registry(), "chat")).toEqual(current);
    expect(readChannelBinding(store, COLLABORATION_CHANNEL_OWNER, "chat")!.descriptor).toEqual(current);
  } finally { store.close(); }
});

test("incomplete legacy Source registration cannot gain a replacement channel during upgrade", () => {
  const store = new RuntimeStore(":memory:");
  try {
    const configuration = config(); saveLegacy(store, configuration.sources[0]!, old, false); migrateCollaborationChannels(store);
    expect(() => resolveCollaborationChannel(store, configuration, registry(), "chat")).toThrow("incomplete");
    expect(readChannelBinding(store, COLLABORATION_CHANNEL_OWNER, "chat")).toBeUndefined();
  } finally { store.close(); }
});
