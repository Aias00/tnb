import packageJson from "../../../package.json";
import type { BuiltinHostPlugin, HostPluginFactory } from "../../agent/plugins";
import type { ChannelConnection } from "../../agent/extensions";
import { COLLABORATION_SERVICE, COLLABORATION_SERVICE_REF } from "../../agent/collaboration-service";
import { CHANNEL_SERVICE, CHANNEL_SERVICE_REF } from "../../agent/channel-service";
import type { SourcePort, PullRequestFacts, Source } from "../../services/collaboration/types";
import { CollaborationHost } from "../../services/collaboration/host";
import { hostCodeFingerprint } from "../../agent/plugin-fingerprint";
import { encodeJson } from "../../services/runtime/json";

export const COLLABORATION_EXTENSION = { kind: "application" as const, id: "collaboration", version: "1" };
export { CHANNEL_SERVICE } from "../../agent/channel-service";
export function collaborationSetup(): HostPluginFactory {
  return api => api.registerApplication({ id: "collaboration", version: "1", async start(context) {
    const service = context.service(COLLABORATION_SERVICE_REF).open(context.signal);
    context.onDispose(service.close);
    const configuration = service.configuration();
    if (!configuration.enabled) return { handle: request => request.method === "GET" ? Response.json({ enabled: false }) : Response.json({ error: "Collaboration is not enabled" }, { status: 400 }), status: () => ({ enabled: false }) };
    const channels = context.service(CHANNEL_SERVICE_REF);
    const ports = new Map<string, SourcePort>(), connections: ChannelConnection[] = [];
    const available: Source[] = [], unavailable = new Map<string, string>();
    // Register before opening any channel, so a partial startup always closes earlier connections.
    context.onDispose(async () => { const errors: unknown[] = []; for (const connection of connections.reverse()) { try { await connection.close(); } catch (error) { errors.push(error); } } if (errors.length) throw new AggregateError(errors, "Channel cleanup failed"); });
    for (const source of configuration.sources) {
      try {
        const descriptor = service.channel(source.id);
        if (source.type === "plugin") source.channel = descriptor;
        const connection = await channels.connect(descriptor, JSON.parse(encodeJson(source.type === "plugin" ? source.options ?? {} : source)));
        connections.push(connection);
        ports.set(source.id, { ...connection.port, ...(connection.port.observe ? { inspectPR: async (number, signal) => {
          const value = await connection.port.observe!({ kind: "github.pull-request", id: String(number) }, signal);
          // PR binding remains restricted to a fixed GitHub Source by CollaborationEngine.
          const facts = value as unknown as PullRequestFacts;
          if (!facts || facts.number !== number || typeof facts.head !== "string" || !Array.isArray(facts.ci) || !Array.isArray(facts.reviews)) throw new Error("Invalid channel PR observation");
          return facts;
        } } : {}) });
        available.push(source);
      } catch (error) { context.signal.throwIfAborted(); unavailable.set(source.id, error instanceof Error ? error.message : String(error)); }
    }
    const host = new CollaborationHost(service, { ...configuration, sources: available }, ports, unavailable);
    context.onDispose(() => host.close());
    await host.start();
    const status = () => {
      const value = host.status() as { sources: Array<{ id: string; [key: string]: unknown }>; [key: string]: unknown };
      return { ...value, ready: unavailable.size === 0, sources: configuration.sources.map(source => ({ id: source.id, type: source.type,
        ...value.sources.find(row => row.id === source.id), available: !unavailable.has(source.id), ...(unavailable.has(source.id) ? { error: unavailable.get(source.id) } : {}) })) };
    };
    return { handle: async request => request.method === "GET" && (new URL(request.url).searchParams.get("kind") ?? "status") === "status"
      ? Response.json(status()) : Response.json(await host.resource(request)), status: () => JSON.parse(encodeJson(status())) };
  } });
}
export async function createCollaborationPlugin(): Promise<BuiltinHostPlugin> {
  return { identity: { name: "tnb-collaboration", version: packageJson.version, fingerprint: await hostCodeFingerprint() },
    extensions: [{ ...COLLABORATION_EXTENSION, entry: "index.mjs", services: [COLLABORATION_SERVICE, CHANNEL_SERVICE], requires: [] }], setup: collaborationSetup() };
}
export default collaborationSetup();
