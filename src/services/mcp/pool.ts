import { connectMcpServers, type McpConnections } from "./manager";
import type { McpConfig } from "./config";
export type McpConnectionStatus = { state: "connected" | "connecting" | "failed" | "needs-auth" | "disabled"; lastError?: string };
/** Independent slots: recovery never tears down unrelated servers. */
export async function connectMcpPool(config: McpConfig, options: Parameters<typeof connectMcpServers>[1]): Promise<McpConnections & { statuses: Record<string, McpConnectionStatus>; reconnect(name: string): Promise<void> }> {
  const lifetime = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  const slots = new Map<string, McpConnections>(), pending = new Map<string, Promise<void>>();
  const names = [...new Set([...Object.keys(config.mcpServers), ...Object.keys(options.inProcess ?? {})])].filter(name => !options.only || options.only.includes(name));
  const statuses: Record<string, McpConnectionStatus> = Object.create(null);
  let closed = false;
  function reconnect(name: string): Promise<void> {
    if (closed || signal.aborted) return Promise.reject(new Error("MCP connections are closed"));
    if (!names.includes(name)) return Promise.reject(new Error(`Unknown MCP server: ${name}`));
    if (config.mcpServers[name]?.enabled === false) return Promise.reject(new Error(`MCP server is disabled: ${name}`));
    if (pending.has(name)) return pending.get(name)!;
    if (slots.has(name) && options.inProcess?.[name]) return Promise.reject(new Error("In-process MCP reconnection requires a fresh host transport"));
    statuses[name] = { state: "connecting" };
    const work = (async () => {
      try {
        const next = await connectMcpServers(config, { ...options, signal, only: [name] });
        if (closed || signal.aborted) { await next.close(); throw new Error("MCP connections are closed"); }
        const existingNames = new Set([...slots.entries()].filter(([key]) => key !== name).flatMap(([, slot]) => slot.tools.map(tool => tool.name)));
        if (next.tools.some(tool => existingNames.has(tool.name))) { await next.close(); throw new Error("Duplicate MCP tool name across servers"); }
        const previous = slots.get(name); slots.set(name, next); statuses[name] = { state: "connected" };
        await previous?.close();
      } catch (error) {
        const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
        statuses[name] = { state: slots.has(name) ? "connected" : status === 401 || status === 403 ? "needs-auth" : "failed", lastError: "Connection attempt failed; check the server configuration or authentication." };
        throw error;
      }
    })().finally(() => pending.delete(name));
    pending.set(name, work); return work;
  }
  for (const name of names) statuses[name] = { state: config.mcpServers[name]?.enabled === false ? "disabled" : "connecting" };
  await Promise.allSettled(names.filter(name => statuses[name]!.state !== "disabled").map(reconnect));
  if (signal.aborted) { await Promise.allSettled([...slots.values()].map(slot => slot.close())); signal.throwIfAborted(); }
  const values = () => names.flatMap(name => slots.has(name) ? [slots.get(name)!] : []);
  return {
    get statuses() {
      for (const [name, slot] of slots) if (statuses[name]?.state === "connected" && Object.values(slot.clients).some(client => !client.isConnected)) statuses[name] = { state: "failed", lastError: "Connection was lost; reconnect this server." };
      return statuses;
    }, reconnect,
    get tools() { return values().flatMap(slot => slot.tools); },
    get ordinaryTools() { return values().flatMap(slot => [...slot.ordinaryTools]); },
    get prompts() { return values().flatMap(slot => slot.prompts); },
    get clients() { return Object.assign({}, ...values().map(slot => slot.clients)); },
    get updatedResources() { return Object.assign({}, ...values().map(slot => slot.updatedResources)); },
    get refreshErrors() { return Object.assign({}, ...values().map(slot => slot.refreshErrors)); },
    async refresh(name, capability) { const slot = slots.get(name); if (!slot) throw new Error(`MCP server is not connected: ${name}`); await slot.refresh(name, capability); },
    async notifyRootsChanged() { await Promise.all(values().map(slot => slot.notifyRootsChanged())); },
    async close() { closed = true; lifetime.abort(); await Promise.allSettled([...pending.values()]); await Promise.allSettled(values().map(slot => slot.close())); slots.clear(); },
  };
}
