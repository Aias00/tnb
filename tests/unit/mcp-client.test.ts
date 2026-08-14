import { describe, expect, test } from "bun:test";

import {
  MCP_TIMEOUT_DEFAULTS,
  McpClient,
  McpSessionExpiredError,
  type JsonRpcMessage,
  type McpTransport,
} from "../../src/services/mcp/client";

class MemoryTransport implements McpTransport {
  readonly supportsModernProtocolProbe: boolean;
  readonly sent: JsonRpcMessage[] = [];
  closed = false;
  private receive?: (message: JsonRpcMessage) => void;

  constructor(
    private readonly respond: (message: JsonRpcMessage) => JsonRpcMessage | undefined,
    modern = false,
  ) {
    this.supportsModernProtocolProbe = modern;
  }

  async start(receive: (message: JsonRpcMessage) => void): Promise<void> {
    this.receive = receive;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(structuredClone(message));
    const response = this.respond(message);
    if (response) queueMicrotask(() => this.receive?.(response));
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  deliver(message: JsonRpcMessage): void {
    this.receive?.(structuredClone(message));
  }
}

describe("MCP client", () => {
  test("opens and cancels a correlated 2026-07-28 subscription", async () => {
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message)) return undefined;
      if (message.method === "server/discover") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resultType: "complete",
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: { listChanged: true } },
          },
        };
      }
      if (message.method === "subscriptions/listen") {
        queueMicrotask(() => transport.deliver({
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: {
            notifications: { toolsListChanged: true },
            _meta: { "io.modelcontextprotocol/subscriptionId": message.id },
          },
        }));
      }
      return undefined;
    }, true);
    const client = new McpClient(transport, { protocolMode: "auto" });

    await client.connect();
    const subscription = await client.listen({ toolsListChanged: true });
    expect(subscription.honored).toEqual({ toolsListChanged: true });
    await subscription.close();
    expect(await subscription.closed).toBe("cancelled");
    expect(transport.sent.at(-1)).toMatchObject({
      method: "notifications/cancelled",
      params: { requestId: subscription.id },
    });
    await client.close();
  });

  test("polls task results and fulfills task input requests", async () => {
    let status = 0;
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message)) return undefined;
      if (message.method === "server/discover") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resultType: "complete",
            supportedVersions: ["2026-07-28"],
            capabilities: {
              tools: {},
              extensions: { "io.modelcontextprotocol/tasks": {} },
            },
          },
        };
      }
      if (message.method === "tools/call") {
        return { jsonrpc: "2.0", id: message.id, result: task("working") };
      }
      if (message.method === "tasks/get") {
        status += 1;
        return status === 1
          ? {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                ...task("input_required"),
                resultType: "complete",
                inputRequests: {
                  approval: { method: "elicitation/create", params: { message: "Approve?" } },
                },
              },
            }
          : {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                ...task("completed"),
                resultType: "complete",
                result: { resultType: "complete", content: [{ type: "text", text: "done" }] },
              },
            };
      }
      return { jsonrpc: "2.0", id: message.id, result: { resultType: "complete" } };
    }, true);
    const task = (taskStatus: string) => ({
      resultType: "task",
      taskId: "task-1",
      status: taskStatus,
      createdAt: "2026-08-11T00:00:00Z",
      lastUpdatedAt: "2026-08-11T00:00:00Z",
      ttlMs: 60_000,
      pollIntervalMs: 0,
    });
    const client = new McpClient(transport, {
      protocolMode: "auto",
      elicitation: async () => ({ action: "accept", content: {} }),
    });

    await client.connect();
    expect(await client.callTool("deploy", {})).toEqual({
      content: [{ type: "text", text: "done" }],
    });
    expect(transport.sent.find((message) =>
      "method" in message && message.method === "tasks/update"
    )).toMatchObject({
      params: {
        taskId: "task-1",
        inputResponses: { approval: { action: "accept", content: {} } },
      },
    });
    await client.close();
  });

  test("uses 2026-07-28 discovery and per-request metadata without initialize", async () => {
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message)) return undefined;
      if (message.method === "server/discover") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resultType: "complete",
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
          },
        };
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { resultType: "complete", tools: [] },
      };
    }, true);
    const client = new McpClient(transport, { protocolMode: "auto" });

    await client.connect();
    expect(await client.listTools()).toEqual([]);
    expect(transport.sent.map((message) => "method" in message ? message.method : undefined))
      .toEqual(["server/discover", "tools/list"]);
    expect((transport.sent[0] as { params: { _meta: Record<string, unknown> } }).params._meta)
      .toEqual({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "tnb", version: "0.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {
          extensions: { "io.modelcontextprotocol/tasks": {} },
        },
      });
  });

  test("fulfills 2026-07-28 MRTR elicitation and retries the original request", async () => {
    let calls = 0;
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message)) return undefined;
      if (message.method === "server/discover") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resultType: "complete",
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
          },
        };
      }
      calls += 1;
      if (calls === 1) {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resultType: "input_required",
            inputRequests: {
              approval: {
                method: "elicitation/create",
                params: { mode: "form", message: "Approve?", requestedSchema: { type: "object" } },
              },
            },
            requestState: "opaque-state",
          },
        };
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { resultType: "complete", content: [{ type: "text", text: "done" }] },
      };
    }, true);
    const client = new McpClient(transport, {
      protocolMode: "auto",
      elicitation: async () => ({ action: "accept", content: {} }),
    });

    await client.connect();
    expect(await client.callTool("deploy", {})).toEqual({
      content: [{ type: "text", text: "done" }],
    });
    const retry = transport.sent.at(-1) as { params: Record<string, unknown> };
    expect(retry.params.inputResponses).toEqual({
      approval: { action: "accept", content: {} },
    });
    expect(retry.params.requestState).toBe("opaque-state");
  });

  test("uses separate established timeouts for connection, requests, and tools", () => {
    expect(MCP_TIMEOUT_DEFAULTS).toEqual({
      connectionMs: 30_000,
      requestMs: 60_000,
      toolMs: 100_000_000,
    });
  });

  test("initializes before listing every page of tools", async () => {
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message)) return undefined;
      if (message.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" },
          },
        };
      }
      const cursor = (message.params as { cursor?: string } | undefined)?.cursor;
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: cursor
          ? {
              tools: [
                {
                  name: "second.tool",
                  description: "Second",
                  inputSchema: { type: "object" },
                },
              ],
            }
          : {
              tools: [
                {
                  name: "first",
                  description: "First",
                  inputSchema: { type: "object" },
                },
              ],
              nextCursor: "page-2",
            },
      };
    });
    const client = new McpClient(transport, { connectionTimeoutMs: 100, requestTimeoutMs: 100 });

    await client.connect();
    const tools = await client.listTools();

    expect(transport.sent.slice(0, 2)).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "tnb", version: "0.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["first", "second.tool"]);
    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: { cursor: "page-2" },
    });
  });

  test("advertises dynamic roots and notifies the server when they change", async () => {
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message) || message.method !== "initialize") {
        return undefined;
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        },
      };
    });
    let root = "file:///workspace/one";
    const client = new McpClient(transport, {
      roots: () => [{ uri: root }],
    });
    await client.connect();

    expect(transport.sent[0]).toMatchObject({
      method: "initialize",
      params: { capabilities: { roots: { listChanged: true } } },
    });
    transport.deliver({ jsonrpc: "2.0", id: "roots-1", method: "roots/list" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(transport.sent).toContainEqual({
      jsonrpc: "2.0",
      id: "roots-1",
      result: { roots: [{ uri: "file:///workspace/one" }] },
    });

    root = "file:///workspace/two";
    await client.notifyRootsChanged();
    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/roots/list_changed",
    });
    transport.deliver({ jsonrpc: "2.0", id: "roots-2", method: "roots/list" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(transport.sent).toContainEqual({
      jsonrpc: "2.0",
      id: "roots-2",
      result: { roots: [{ uri: "file:///workspace/two" }] },
    });
  });

  test("reinitializes an expired session, restores subscriptions, and retries the request", async () => {
    let expired = false;
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message)) return undefined;
      if (message.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {}, resources: { subscribe: true } },
          },
        };
      }
      if (message.method === "tools/list" && !expired) {
        expired = true;
        throw new McpSessionExpiredError();
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: message.method === "tools/list" ? { tools: [] } : {},
      };
    });
    const client = new McpClient(transport, { connectionTimeoutMs: 100, requestTimeoutMs: 100 });
    await client.connect();
    await client.subscribeResource("memory://notes");

    expect(await client.listTools()).toEqual([]);
    expect(
      transport.sent.filter(
        (message) => "method" in message && message.method === "initialize",
      ),
    ).toHaveLength(2);
    expect(
      transport.sent.filter(
        (message) => "method" in message && message.method === "resources/subscribe",
      ),
    ).toHaveLength(2);
    expect(transport.sent.at(-1)).toMatchObject({ method: "tools/list" });
  });

  test("requests validated prompt and resource-template argument completions", async () => {
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message)) return undefined;
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: message.method === "initialize"
          ? { protocolVersion: "2025-11-25", capabilities: { completions: {}, resources: {} } }
          : { completion: { values: ["main", "maintenance"], total: 3, hasMore: true } },
      };
    });
    const client = new McpClient(transport, { connectionTimeoutMs: 100, requestTimeoutMs: 100 });
    await client.connect();

    expect(await client.completeArgument(
      { type: "ref/resource", uri: "git://repository/{branch}/{path}" },
      { name: "branch", value: "ma" },
      { path: "src" },
    )).toEqual({ values: ["main", "maintenance"], total: 3, hasMore: true });
    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "completion/complete",
      params: {
        ref: { type: "ref/resource", uri: "git://repository/{branch}/{path}" },
        argument: { name: "branch", value: "ma" },
        context: { arguments: { path: "src" } },
      },
    });
    expect(await client.completeArgument(
      { type: "ref/prompt", name: "review" },
      { name: "language", value: "py" },
    )).toEqual({ values: ["main", "maintenance"], total: 3, hasMore: true });
    expect(transport.sent.at(-1)).toMatchObject({
      method: "completion/complete",
      params: {
        ref: { type: "ref/prompt", name: "review" },
        argument: { name: "language", value: "py" },
      },
    });
  });

  test("returns tool results and surfaces JSON-RPC errors", async () => {
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message)) return undefined;
      if (message.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
        };
      }
      if ((message.params as { name?: string }).name === "broken") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: "Unknown tool" },
        };
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "42" }], isError: false },
      };
    });
    const client = new McpClient(transport, { connectionTimeoutMs: 100, toolTimeoutMs: 100 });
    await client.connect();

    expect(await client.callTool("answer", { value: 42 })).toEqual({
      content: [{ type: "text", text: "42" }],
      isError: false,
    });
    expect(transport.sent.at(-1)).toMatchObject({
      method: "tools/call",
      params: {
        name: "answer",
        arguments: { value: 42 },
        _meta: { progressToken: "tnb-1" },
      },
    });
    await expect(client.callTool("broken", {})).rejects.toThrow("MCP error -32602: Unknown tool");
  });

  test("accepts any JSON value as 2026-07-28 structured tool content", async () => {
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message)) return undefined;
      if (message.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
        };
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [], structuredContent: [1, "two", null] },
      };
    });
    const client = new McpClient(transport);
    await client.connect();

    expect(await client.callTool("values", {})).toEqual({
      content: [],
      structuredContent: [1, "two", null],
    });
  });

  test("supports resource-only servers and prompt expansion", async () => {
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message)) return undefined;
      const results: Record<string, unknown> = {
        initialize: {
          protocolVersion: "2025-11-25",
          capabilities: { resources: {}, prompts: {} },
        },
        "resources/list": {
          resources: [{ uri: "memory://notes", name: "Notes", mimeType: "text/plain" }],
        },
        "resources/read": {
          contents: [{ uri: "memory://notes", mimeType: "text/plain", text: "remember this" }],
        },
        "prompts/list": {
          prompts: [{ name: "review", arguments: [{ name: "target", required: true }] }],
        },
        "prompts/get": {
          description: "Review a target",
          messages: [{ role: "user", content: { type: "text", text: "Review src" } }],
        },
      };
      return { jsonrpc: "2.0", id: message.id, result: results[message.method] };
    });
    const client = new McpClient(transport, { connectionTimeoutMs: 100, requestTimeoutMs: 100 });

    await client.connect();
    expect(await client.listTools()).toEqual([]);
    expect(await client.listResources()).toEqual([
      { uri: "memory://notes", name: "Notes", mimeType: "text/plain" },
    ]);
    expect(await client.readResource("memory://notes")).toEqual([
      { uri: "memory://notes", mimeType: "text/plain", text: "remember this" },
    ]);
    expect(await client.listPrompts()).toEqual([
      { name: "review", arguments: [{ name: "target", required: true }] },
    ]);
    expect(await client.getPrompt("review", { target: "src" })).toEqual({
      description: "Review a target",
      messages: [{ role: "user", content: { type: "text", text: "Review src" } }],
    });
  });

  test("lists resource templates and manages update subscriptions", async () => {
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message)) return undefined;
      const result = message.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { resources: { subscribe: true, listChanged: true } },
          }
        : message.method === "resources/templates/list"
          ? {
              resourceTemplates: [
                {
                  uriTemplate: "git://repository/{ref}",
                  name: "Git ref",
                  title: "Repository reference",
                  mimeType: "text/plain",
                },
              ],
            }
          : {};
      return { jsonrpc: "2.0", id: message.id, result };
    });
    const client = new McpClient(transport, { connectionTimeoutMs: 100, requestTimeoutMs: 100 });
    const updates: string[] = [];

    await client.connect();
    expect(client.supportsResourceSubscriptions()).toBe(true);
    expect(await client.listResourceTemplates()).toEqual([
      {
        uriTemplate: "git://repository/{ref}",
        name: "Git ref",
        title: "Repository reference",
        mimeType: "text/plain",
      },
    ]);
    const stop = client.onResourceUpdated((uri) => updates.push(uri));
    await client.subscribeResource("git://repository/main");
    transport.deliver({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri: "git://repository/main/src" },
    });
    expect(updates).toEqual(["git://repository/main/src"]);
    await client.unsubscribeResource("git://repository/main");
    stop();
    expect(transport.sent.filter((message) => "method" in message).slice(-2)).toEqual([
      {
        jsonrpc: "2.0",
        id: 3,
        method: "resources/subscribe",
        params: { uri: "git://repository/main" },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "resources/unsubscribe",
        params: { uri: "git://repository/main" },
      },
    ]);
    await client.subscribeResource("git://repository/release");
    await client.close();
    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 6,
      method: "resources/unsubscribe",
      params: { uri: "git://repository/release" },
    });
    expect(transport.closed).toBe(true);
  });

  test("times out an unanswered request and closes pending work", async () => {
    const transport = new MemoryTransport(() => undefined);
    const client = new McpClient(transport, { connectionTimeoutMs: 5 });

    await expect(client.connect()).rejects.toThrow("MCP request initialize timed out");
    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1, reason: "Request timed out" },
    });
    await client.close();
    expect(transport.closed).toBe(true);
  });

  test("applies the ordinary request timeout to tool discovery", async () => {
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message) || message.method !== "initialize") {
        return undefined;
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
      };
    });
    const client = new McpClient(transport, {
      connectionTimeoutMs: 100,
      requestTimeoutMs: 5,
      toolTimeoutMs: 100,
    });
    await client.connect();

    await expect(client.listTools()).rejects.toThrow("MCP request tools/list timed out");
  });

  test("applies the long-running tool timeout only to tool calls", async () => {
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message) || message.method !== "initialize") {
        return undefined;
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
      };
    });
    const client = new McpClient(transport, {
      connectionTimeoutMs: 100,
      requestTimeoutMs: 100,
      toolTimeoutMs: 5,
    });
    await client.connect();

    await expect(client.callTool("slow", {})).rejects.toThrow("MCP request tools/call timed out");
  });

  test("advertises sampling tools and answers server-initiated sampling requests", async () => {
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message) || message.method !== "initialize") {
        return undefined;
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
      };
    });
    const client = new McpClient(transport, {
      sampling: async (params) => ({
        role: "assistant",
        content: { type: "text", text: String((params as { prompt?: string }).prompt) },
        model: "fixture",
        stopReason: "endTurn",
      }),
    });
    await client.connect();

    expect((transport.sent[0] as { params: { capabilities: unknown } }).params.capabilities)
      .toEqual({ sampling: { tools: {} } });
    transport.deliver({
      jsonrpc: "2.0",
      id: "sample-1",
      method: "sampling/createMessage",
      params: { prompt: "hello" },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "sample-1",
      result: {
        role: "assistant",
        content: { type: "text", text: "hello" },
        model: "fixture",
        stopReason: "endTurn",
      },
    });
    await client.close();
  });

  test("returns method-not-found when sampling was not negotiated", async () => {
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message) || message.method !== "initialize") {
        return undefined;
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
      };
    });
    const client = new McpClient(transport);
    await client.connect();
    transport.deliver({ jsonrpc: "2.0", id: 99, method: "sampling/createMessage", params: {} });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 99,
      error: { code: -32601, message: "Unsupported MCP client method: sampling/createMessage" },
    });
    await client.close();
  });

  test("cancels only the matching server-initiated sampling request", async () => {
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message) || message.method !== "initialize") {
        return undefined;
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
      };
    });
    const client = new McpClient(transport, {
      sampling: async (_params, signal) => await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });
    await client.connect();
    transport.deliver({
      jsonrpc: "2.0",
      id: "sample-cancel",
      method: "sampling/createMessage",
      params: {},
    });
    transport.deliver({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "sample-cancel", reason: "No longer needed" },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "sample-cancel",
      error: { code: -32800, message: "Request cancelled" },
    });
    await client.close();
  });

  test("advertises and handles form and URL elicitation", async () => {
    const transport = new MemoryTransport((message) => {
      if (!("id" in message) || !("method" in message) || message.method !== "initialize") {
        return undefined;
      }
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
      };
    });
    const client = new McpClient(transport, {
      elicitation: async (params) => ({
        action: "accept",
        content: { echoed: (params as { message?: unknown }).message },
      }),
    });
    await client.connect();
    expect((transport.sent[0] as { params: { capabilities: unknown } }).params.capabilities)
      .toEqual({ elicitation: { form: {}, url: {} } });

    transport.deliver({
      jsonrpc: "2.0",
      id: "elicit-1",
      method: "elicitation/create",
      params: { message: "hello" },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(transport.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "elicit-1",
      result: { action: "accept", content: { echoed: "hello" } },
    });
    await client.close();
  });
});
