import type { AgentTool } from "../../core/tool";
import { McpClient, McpRequestError } from "./client";
import type { McpConfig } from "./config";
import { StreamableHttpMcpTransport } from "./http";
import { LegacySseMcpTransport } from "./sse";
import { StdioMcpTransport } from "./stdio";
import type { McpTransport } from "./client";
import { McpOAuthClient } from "./oauth";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import {
  createMcpResourceTool,
  createMcpResourceUpdatesTool,
  createMcpTools,
} from "./tools";
import { createMcpPromptCommands, type McpPromptCommand } from "./prompts";
import type { McpSamplingHandler } from "./sampling";
import type { McpElicitationHandler } from "./elicitation";
import {
  parseMcpCancelledEvent,
  parseMcpProgressEvent,
  type McpCancelledEvent,
  type McpProgressEvent,
} from "./activity";
import {
  meetsMcpLogLevel,
  parseMcpLogMessage,
  type McpLogMessage,
} from "./logging";

export type McpConnections = {
  tools: AgentTool[];
  prompts: McpPromptCommand[];
  clients: Readonly<Record<string, McpClient>>;
  updatedResources: Readonly<Record<string, ReadonlySet<string>>>;
  refreshErrors: Readonly<Record<string, string>>;
  refresh(serverName: string, capability?: "tools" | "resources" | "prompts"): Promise<void>;
  notifyRootsChanged(): Promise<void>;
  close(): Promise<void>;
};

export async function connectMcpServers(
  config: McpConfig,
  options: {
    cwd: string;
    requestTimeoutMs?: number;
    inProcess?: Record<string, McpTransport>;
    configDir?: string;
    only?: string[];
    workspaceRoot?(): string | string[];
    sampling?(serverName: string): McpSamplingHandler;
    elicitation?(serverName: string): McpElicitationHandler;
    elicitationComplete?(serverName: string, elicitationId: string): void | Promise<void>;
    logging?(message: McpLogMessage): void | Promise<void>;
    progress?(event: McpProgressEvent): void | Promise<void>;
    cancelled?(event: McpCancelledEvent): void | Promise<void>;
  },
): Promise<McpConnections> {
  const clients: McpClient[] = [];
  const clientsByName: Record<string, McpClient> = {};
  const tools: AgentTool[] = [];
  const prompts: McpPromptCommand[] = [];
  const refreshErrors: Record<string, string> = {};
  const updatedResources: Record<string, Set<string>> = {};
  const serverNames = new Set<string>();
  const serverOrder: string[] = [];
  const ordinaryToolSnapshots = new Map<string, AgentTool[]>();
  const resourceToolSnapshots = new Map<string, AgentTool[]>();
  const promptSnapshots = new Map<string, McpPromptCommand[]>();
  const refreshGenerations = new Map<string, number>();
  const selected = options.only ? new Set(options.only) : undefined;
  const refresh = async (
    serverName: string,
    capability?: "tools" | "resources" | "prompts",
  ): Promise<void> => {
    const client = clientsByName[serverName];
    if (!client) throw new Error(`Unknown connected MCP server: ${serverName}`);
    const capabilities = capability ? [capability] : ["tools", "resources", "prompts"] as const;
    for (const target of capabilities) {
      const generationKey = `${serverName}:${target}`;
      const generation = (refreshGenerations.get(generationKey) ?? 0) + 1;
      refreshGenerations.set(generationKey, generation);
      if (target === "tools") {
        const definitions = await client.listTools();
        if (refreshGenerations.get(generationKey) !== generation) continue;
        const next = createMcpTools(serverName, client, definitions);
        replaceTools(
          tools,
          serverOrder,
          ordinaryToolSnapshots,
          resourceToolSnapshots,
          { serverName, ordinary: next },
        );
        ordinaryToolSnapshots.set(serverName, next);
      } else if (target === "resources") {
        let resourceTools: AgentTool[] = [];
        if (client.supportsCapability("resources")) {
          const [definitions, templates] = await Promise.all([
            client.listResources(),
            client.listResourceTemplates(),
          ]);
          const canSubscribe = client.supportsResourceSubscriptions();
          resourceTools = [
            createMcpResourceTool(serverName, client, definitions, { templates, canSubscribe }),
            ...(canSubscribe
              ? [createMcpResourceUpdatesTool(serverName, updatedResources[serverName] ??= new Set())]
              : []),
          ];
        }
        if (refreshGenerations.get(generationKey) !== generation) continue;
        replaceTools(
          tools,
          serverOrder,
          ordinaryToolSnapshots,
          resourceToolSnapshots,
          { serverName, resources: resourceTools },
        );
        resourceToolSnapshots.set(serverName, resourceTools);
      } else {
        const definitions = await client.listPrompts();
        if (refreshGenerations.get(generationKey) !== generation) continue;
        const next = createMcpPromptCommands(serverName, definitions);
        replacePrompts(prompts, serverOrder, promptSnapshots, { serverName, prompts: next });
        promptSnapshots.set(serverName, next);
      }
      delete refreshErrors[generationKey];
    }
  };
  const scheduleRefresh = (serverName: string, capability: "tools" | "resources" | "prompts") => {
    void refresh(serverName, capability).catch((error) => {
      refreshErrors[`${serverName}:${capability}`] = error instanceof Error ? error.message : String(error);
    });
  };
  try {
    const configured = Object.entries(config.mcpServers)
      .filter(([name, server]) => server.enabled !== false && (!selected || selected.has(name)))
      .map(([name, server]) => ({ name, server }));
    const injected = Object.entries(options.inProcess ?? {})
      .filter(([name]) => !selected || selected.has(name))
      .map(([name, transport]) => ({ name, transport }));
    for (const connection of [...configured, ...injected]) {
      const serverName = connection.name;
      if (serverNames.has(serverName)) throw new Error(`Duplicate MCP server name: ${serverName}`);
      serverNames.add(serverName);
      serverOrder.push(serverName);
      const transport = "transport" in connection
        ? connection.transport
        : connection.server.type === "http" || connection.server.type === "sse"
          ? createRemoteTransport(serverName, connection.server, options.configDir)
            : new StdioMcpTransport({ ...connection.server, cwd: options.cwd });
      const samplingHandler = options.sampling?.(serverName);
      const elicitationHandler = options.elicitation?.(serverName);
      let clientHandlersReady = false;
      const client = new McpClient(
        transport,
        {
              ...("server" in connection && connection.server.protocol !== undefined
                ? { protocolMode: connection.server.protocol }
                : {}),
              ...(options.requestTimeoutMs === undefined
                ? {}
                : { requestTimeoutMs: options.requestTimeoutMs }),
              ...(options.sampling === undefined
                ? {}
                : {
                    sampling: (params: unknown, signal: AbortSignal) => {
                      if (!clientHandlersReady || !samplingHandler) {
                        throw new McpRequestError(-1, "Sampling UI is not ready");
                      }
                      return samplingHandler(params, signal);
                    },
                  }),
              ...(options.elicitation === undefined
                ? {}
                : {
                    elicitation: (params: unknown, signal: AbortSignal) =>
                      !clientHandlersReady || !elicitationHandler
                        ? Promise.resolve({ action: "cancel" })
                        : elicitationHandler(params, signal),
                  }),
              roots: () => {
                const roots = options.workspaceRoot?.() ?? options.cwd;
                return (Array.isArray(roots) ? roots : [roots]).map((root) => ({ uri: pathToFileURL(root).href }));
              },
        },
      );
      clients.push(client);
      await client.connect();
      clientsByName[serverName] = client;
      client.onNotification("notifications/progress", (params) => {
        const event = parseMcpProgressEvent(serverName, params);
        if (!event || !options.progress) return;
        void Promise.resolve(options.progress(event)).catch((error) => {
          refreshErrors[`${serverName}:progress`] = error instanceof Error ? error.message : String(error);
        });
      });
      client.onNotification("notifications/cancelled", (params) => {
        const event = parseMcpCancelledEvent(serverName, params);
        if (!event || !options.cancelled) return;
        void Promise.resolve(options.cancelled(event)).catch((error) => {
          refreshErrors[`${serverName}:cancelled`] = error instanceof Error ? error.message : String(error);
        });
      });
      if (client.supportsLegacyLogging()) {
        const minimumLogLevel = "server" in connection
          ? connection.server.logLevel ?? "info"
          : "info";
        client.onNotification("notifications/message", (params) => {
          const message = parseMcpLogMessage(serverName, params);
          if (!message || !meetsMcpLogLevel(message.level, minimumLogLevel) || !options.logging) return;
          void Promise.resolve(options.logging(message)).catch((error) => {
            refreshErrors[`${serverName}:logging`] = error instanceof Error ? error.message : String(error);
          });
        });
        await client.setLoggingLevel(minimumLogLevel);
      }
      if (client.supportsResourceSubscriptions()) {
        const updates = updatedResources[serverName] ??= new Set<string>();
        client.onResourceUpdated((uri) => updates.add(uri));
      }
      client.onNotification("notifications/tools/list_changed", () => scheduleRefresh(serverName, "tools"));
      client.onNotification("notifications/resources/list_changed", () => scheduleRefresh(serverName, "resources"));
      client.onNotification("notifications/prompts/list_changed", () => scheduleRefresh(serverName, "prompts"));
      client.onNotification("notifications/elicitation/complete", (params) => {
        const elicitationId = elicitationCompletionId(params);
        if (!elicitationId || !options.elicitationComplete) return;
        void Promise.resolve(options.elicitationComplete(serverName, elicitationId)).catch((error) => {
          refreshErrors[`${serverName}:elicitation`] = error instanceof Error ? error.message : String(error);
        });
      });
      await refresh(serverName);
      await client.listenForChanges({
        ...(clientCapabilityListChanged(client, "tools") ? { toolsListChanged: true } : {}),
        ...(clientCapabilityListChanged(client, "resources") ? { resourcesListChanged: true } : {}),
        ...(clientCapabilityListChanged(client, "prompts") ? { promptsListChanged: true } : {}),
      });
      clientHandlersReady = true;
    }
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()));
    throw error;
  }
  return {
    tools,
    prompts,
    clients: clientsByName,
    updatedResources,
    refreshErrors,
    refresh,
    async notifyRootsChanged() {
      await Promise.all(clients.map((client) => client.notifyRootsChanged()));
    },
    async close() {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}

function clientCapabilityListChanged(
  client: McpClient,
  capability: "tools" | "resources" | "prompts",
): boolean {
  return client.supportsListChanged(capability);
}

function elicitationCompletionId(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  const value = (params as Record<string, unknown>).elicitationId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function replaceTools(
  target: AgentTool[],
  serverOrder: string[],
  ordinarySnapshots: Map<string, AgentTool[]>,
  resourceSnapshots: Map<string, AgentTool[]>,
  replacement?: { serverName: string; ordinary?: AgentTool[]; resources?: AgentTool[] },
): void {
  const next = serverOrder.flatMap((serverName) => [
    ...(replacement?.serverName === serverName && replacement.ordinary
      ? replacement.ordinary
      : ordinarySnapshots.get(serverName) ?? []),
    ...(replacement?.serverName === serverName && replacement.resources
      ? replacement.resources
      : resourceSnapshots.get(serverName) ?? []),
  ]);
  const names = new Set<string>();
  for (const tool of next) {
    if (names.has(tool.name)) throw new Error(`Duplicate MCP tool name: ${tool.name}`);
    names.add(tool.name);
  }
  target.splice(0, target.length, ...next);
}

function replacePrompts(
  target: McpPromptCommand[],
  serverOrder: string[],
  snapshots: Map<string, McpPromptCommand[]>,
  replacement?: { serverName: string; prompts: McpPromptCommand[] },
): void {
  const next = serverOrder.flatMap((serverName) =>
    replacement?.serverName === serverName
      ? replacement.prompts
      : snapshots.get(serverName) ?? []
  );
  const names = new Set<string>();
  for (const prompt of next) {
    if (names.has(prompt.name)) throw new Error(`Duplicate MCP prompt name: ${prompt.name}`);
    names.add(prompt.name);
  }
  target.splice(0, target.length, ...next);
}

function createRemoteTransport(
  serverName: string,
  server: Extract<McpConfig["mcpServers"][string], { type: "http" | "sse" }>,
  configDir: string | undefined,
): McpTransport {
  let authorization: (() => Promise<string>) | undefined;
  if (server.oauth) {
    const oauth = new McpOAuthClient({
      serverName,
      serverUrl: server.url,
      config: server.oauth,
      storagePath: join(configDir ?? join(homedir(), ".tnb"), "mcp-oauth.json"),
    });
    authorization = () => oauth.accessToken();
  }
  const transportOptions = {
    url: server.url,
    ...(server.headers ? { headers: server.headers } : {}),
    ...(authorization ? { authorization } : {}),
  };
  return server.type === "http"
    ? new StreamableHttpMcpTransport(transportOptions)
    : new LegacySseMcpTransport(transportOptions);
}
