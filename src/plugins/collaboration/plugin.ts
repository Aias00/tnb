import packageJson from "../../../package.json";
import type { BuiltinHostPlugin, HostPluginFactory } from "../../agent/plugins";
import type { ChannelConnection, ChannelRegistry } from "../../agent/extensions";
import type { DurableRuntime } from "../../services/runtime/engine-core";
import type { SourcePort, PullRequestFacts } from "../../services/collaboration/types";
import { CollaborationHost } from "../../services/collaboration/host";
import { loadCollaborationConfig } from "../../services/collaboration/config";
import { hostCodeFingerprint } from "../../agent/plugin-fingerprint";
import { digestJson, encodeJson } from "../../services/runtime/json";

export const COLLABORATION_EXTENSION = { kind: "application" as const, id: "collaboration", version: "1" };
export const INTERNAL_RUNTIME_SERVICE = "tnb.runtime.internal/v1";
export const CHANNEL_SERVICE = "tnb.channels/v1";
export function collaborationSetup(settings: { configDir: string; env: Record<string, string | undefined> }): HostPluginFactory {
  return api => api.registerApplication({ id: "collaboration", version: "1", async start(context) {
    const configuration = await loadCollaborationConfig(settings.configDir);
    if (!configuration.enabled) return { handle: request => request.method === "GET" ? Response.json({ enabled: false }) : Response.json({ error: "Collaboration is not enabled" }, { status: 400 }), status: () => ({ enabled: false }) };
    const runtime = context.service<DurableRuntime>(INTERNAL_RUNTIME_SERVICE), channels = context.service<ChannelRegistry>(CHANNEL_SERVICE);
    const ports = new Map<string, SourcePort>(), connections: ChannelConnection[] = [];
    // Register before opening any channel, so a partial startup always closes earlier connections.
    context.onDispose(async () => { const errors: unknown[] = []; for (const connection of connections.reverse()) { try { await connection.close(); } catch (error) { errors.push(error); } } if (errors.length) throw new AggregateError(errors, "Channel cleanup failed"); });
    for (const source of configuration.sources) {
      const descriptor = channels.descriptor(source.channel ?? { id: source.type, version: "1" });
      if (source.type === "plugin") source.channel = descriptor;
      const binding = context.state.get<{ descriptor: typeof descriptor }>(`channel:${source.id}`);
      if (binding && digestJson(binding.value.descriptor) !== digestJson(descriptor)) throw new Error(`Channel generation changed for Source ${source.id}; retain the pinned package or use a new Source ID`);
      if (!binding) context.state.command(`bind:${source.id}`, descriptor, tx => tx.save(`channel:${source.id}`, { descriptor }, 0));
      const connection = await channels.connect(descriptor, JSON.parse(encodeJson(source.type === "plugin" ? source.options ?? {} : source)));
      connections.push(connection);
      ports.set(source.id, { ...connection.port, ...(connection.port.observe ? { inspectPR: async (number, signal) => {
        const value = await connection.port.observe!({ kind: "github.pull-request", id: String(number) }, signal);
        // PR binding remains restricted to a fixed GitHub Source by CollaborationEngine.
        const facts = value as unknown as PullRequestFacts;
        if (!facts || facts.number !== number || typeof facts.head !== "string" || !Array.isArray(facts.ci) || !Array.isArray(facts.reviews)) throw new Error("Invalid channel PR observation");
        return facts;
      } } : {}) });
    }
    const host = new CollaborationHost(runtime, configuration, settings.env, ports);
    context.onDispose(() => host.close());
    await host.start();
    return { handle: async request => Response.json(await host.resource(request)), status: () => JSON.parse(encodeJson(host.status())) };
  } });
}
export async function createCollaborationPlugin(settings: { configDir: string; env: Record<string, string | undefined> }): Promise<BuiltinHostPlugin> {
  return { identity: { name: "tnb-collaboration", version: packageJson.version, fingerprint: await hostCodeFingerprint() },
    extensions: [{ ...COLLABORATION_EXTENSION, entry: "index.mjs", services: [INTERNAL_RUNTIME_SERVICE, CHANNEL_SERVICE], requires: [] }], setup: collaborationSetup(settings) };
}
const setup: HostPluginFactory = api => {
  const settings = api.configuration as { configDir: string; env: Record<string, string | undefined> } | undefined;
  if (!settings?.configDir || !settings.env) throw new Error("Collaboration plugin requires host settings");
  return collaborationSetup(settings)(api);
};
export default setup;
