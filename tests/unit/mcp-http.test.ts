import { describe, expect, test } from "bun:test";

import { McpClient, type JsonRpcMessage } from "../../src/services/mcp/client";
import {
  STREAMABLE_HTTP_RECONNECTION_DEFAULTS,
  StreamableHttpMcpTransport,
} from "../../src/services/mcp/http";
import { readSseEvents } from "../../src/services/mcp/sse";

describe("MCP Streamable HTTP transport", () => {
  test("uses the MCP SDK reconnection defaults", () => {
    expect(STREAMABLE_HTTP_RECONNECTION_DEFAULTS).toEqual({
      initialDelayMs: 1_000,
      maximumDelayMs: 30_000,
      growFactor: 1.5,
      maximumRetries: 2,
    });
  });

  test("preserves SSE id and retry fields, including empty priming events", async () => {
    const response = new Response("id: cursor-1\nretry: 250\n\ndata: next\n\n");
    const events = [];
    for await (const event of readSseEvents(response.body!.getReader())) events.push(event);

    expect(events).toEqual([
      { data: "", id: "cursor-1", retry: 250 },
      { data: "next" },
    ]);
  });

  test("stores initialization metadata and sends it on later requests", async () => {
    const requests: Request[] = [];
    const transport = new StreamableHttpMcpTransport({
      url: "https://mcp.example.test/rpc",
      headers: { authorization: "Bearer token" },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET") return new Response(null, { status: 405 });
        const body = (await request.json()) as { id?: number; method: string };
        if (body.method === "initialize") {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "http", version: "1" },
              },
            },
            { headers: { "MCP-Session-Id": "session-1" } },
          );
        }
        return new Response(null, { status: 202 });
      },
    });
    const received: JsonRpcMessage[] = [];
    await transport.start((message) => void received.push(message));

    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    expect(received[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "http", version: "1" },
      },
    });
    expect(requests[0]?.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer token");
    expect(requests[0]?.headers.get("mcp-session-id")).toBeNull();
    expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-1");
    expect(requests[1]?.headers.get("mcp-protocol-version")).toBe("2025-11-25");
  });

  test("delivers every JSON-RPC message from an SSE response", async () => {
    const transport = new StreamableHttpMcpTransport({
      url: "https://mcp.example.test/rpc",
      fetch: async () =>
        new Response(
          [
            'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"value":1}}\n\n',
            'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n',
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const received: JsonRpcMessage[] = [];
    await transport.start((message) => void received.push(message));

    await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    expect(received).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { value: 1 },
      },
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    ]);
  });

  test("sends 2026-07-28 routing and schema-declared parameter headers", async () => {
    let request: Request | undefined;
    const transport = new StreamableHttpMcpTransport({
      url: "https://mcp.example.test/rpc",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          jsonrpc: "2.0",
          id: 7,
          result: { resultType: "complete", content: [] },
        });
      },
    });
    await transport.start(() => undefined);
    expect(transport.registerToolDefinitions([{
      name: "部署",
      inputSchema: {
        type: "object",
        properties: {
          region: { type: "string", "x-mcp-header": "Region" },
          nested: {
            type: "object",
            properties: { dryRun: { type: "boolean", "x-mcp-header": "Dry-Run" } },
          },
        },
      },
    }])).toHaveLength(1);
    await transport.send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "部署",
        arguments: { region: " us-west1 ", nested: { dryRun: true } },
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    });

    expect(request?.headers.get("mcp-protocol-version")).toBe("2026-07-28");
    expect(request?.headers.get("mcp-method")).toBe("tools/call");
    expect(request?.headers.get("mcp-name")).toBe("=?base64?6YOo572y?=");
    expect(request?.headers.get("mcp-param-region")).toBe("=?base64?IHVzLXdlc3QxIA==?=");
    expect(request?.headers.get("mcp-param-dry-run")).toBe("true");
  });

  test("excludes malformed 2026-07-28 x-mcp-header tool definitions", () => {
    const transport = new StreamableHttpMcpTransport({ url: "https://mcp.example.test/rpc" });
    expect(transport.registerToolDefinitions([
      {
        name: "valid",
        inputSchema: {
          type: "object",
          properties: { tenant: { type: "string", "x-mcp-header": "Tenant" } },
        },
      },
      {
        name: "invalid",
        inputSchema: {
          type: "object",
          oneOf: [{ properties: { tenant: { type: "string", "x-mcp-header": "Tenant" } } }],
        },
      },
    ]).map((tool) => tool.name)).toEqual(["valid"]);
  });

  test("deletes an established session when closed", async () => {
    const methods: string[] = [];
    const transport = new StreamableHttpMcpTransport({
      url: "https://mcp.example.test/rpc",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        methods.push(request.method);
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        if (request.method === "GET") return new Response(null, { status: 405 });
        const body = (await request.json()) as { id: number };
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "http", version: "1" },
            },
          },
          { headers: { "MCP-Session-Id": "session-1" } },
        );
      },
    });
    await transport.start(() => undefined);
    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    await transport.close();

    expect(methods).toEqual(["POST", "POST", "GET", "DELETE"]);
  });

  test("receives independent server notifications over the GET SSE stream", async () => {
    let notifyReceived: (() => void) | undefined;
    const notification = new Promise<void>((resolve) => void (notifyReceived = resolve));
    const transport = new StreamableHttpMcpTransport({
      url: "https://mcp.example.test/rpc",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        if (request.method === "GET") {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(
                'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":"memory://notes"}}\n\n',
              ));
              init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        const body = (await request.json()) as { id: number };
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { resources: { subscribe: true } },
            },
          },
          { headers: { "MCP-Session-Id": "session-notifications" } },
        );
      },
    });
    const received: JsonRpcMessage[] = [];
    await transport.start((message) => {
      received.push(message);
      if ("method" in message && message.method === "notifications/resources/updated") {
        notifyReceived?.();
      }
    });

    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await notification;
    expect(received.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri: "memory://notes" },
    });
    await transport.close();
  });

  test("resumes a closed GET stream with Last-Event-ID", async () => {
    const getRequests: Request[] = [];
    let markResumed: (() => void) | undefined;
    const resumed = new Promise<void>((resolve) => void (markResumed = resolve));
    const transport = new StreamableHttpMcpTransport({
      url: "https://mcp.example.test/rpc",
      reconnection: { initialDelayMs: 0, maximumDelayMs: 0 },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        if (request.method === "GET") {
          getRequests.push(request);
          if (getRequests.length === 1) {
            return new Response("id: cursor-1\nretry: 0\n\n", {
              headers: { "content-type": "text/event-stream" },
            });
          }
          markResumed?.();
          return new Response(null, { status: 405 });
        }
        const message = (await request.json()) as { id?: number; method: string };
        if (message.method === "initialize") {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: { protocolVersion: "2025-11-25", capabilities: { resources: {} } },
            },
            { headers: { "MCP-Session-Id": "resumable-session" } },
          );
        }
        return new Response(null, { status: 202 });
      },
    });
    await transport.start(() => undefined);
    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    await resumed;
    expect(getRequests[0]?.headers.get("last-event-id")).toBeNull();
    expect(getRequests[1]?.headers.get("last-event-id")).toBe("cursor-1");
    await transport.close();
  });

  test("reinitializes after a session 404 and restores resource subscriptions", async () => {
    let generation = 0;
    let expired = false;
    const methods: string[] = [];
    const sessions: Array<string | null> = [];
    const transport = new StreamableHttpMcpTransport({
      url: "https://mcp.example.test/rpc",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET") return new Response(null, { status: 405 });
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        const message = (await request.json()) as { id?: number; method: string };
        methods.push(message.method);
        sessions.push(request.headers.get("mcp-session-id"));
        if (message.method === "initialize") {
          generation += 1;
          return Response.json(
            {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {}, resources: { subscribe: true } },
              },
            },
            { headers: { "MCP-Session-Id": `session-${generation}` } },
          );
        }
        if (message.method === "tools/list" && !expired) {
          expired = true;
          return Response.json(
            { jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "Session not found" } },
            { status: 404 },
          );
        }
        if (message.method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
        }
        if ("id" in message) {
          return Response.json({ jsonrpc: "2.0", id: message.id, result: {} });
        }
        return new Response(null, { status: 202 });
      },
    });
    const client = new McpClient(transport, { connectionTimeoutMs: 100, requestTimeoutMs: 100 });
    await client.connect();
    await client.subscribeResource("memory://notes");

    expect(await client.listTools()).toEqual([]);
    expect(methods.filter((method) => method === "initialize")).toHaveLength(2);
    expect(methods.filter((method) => method === "resources/subscribe")).toHaveLength(2);
    expect(sessions[methods.lastIndexOf("tools/list")]).toBe("session-2");
    await client.close();
  });

  test("cancels only the targeted request and keeps the transport usable", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => void (markStarted = resolve));
    const transportErrors: Error[] = [];
    const transport = new StreamableHttpMcpTransport({
      url: "https://mcp.example.test/rpc",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const message = (await request.json()) as { id?: number; method: string };
        if (message.method === "tools/call") {
          markStarted?.();
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        }
        if (message.method === "notifications/cancelled") {
          return new Response(null, { status: 202 });
        }
        return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
      },
    });
    const received: JsonRpcMessage[] = [];
    await transport.start(
      (message) => void received.push(message),
      (error) => void transportErrors.push(error),
    );
    const pending = transport.send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "slow", arguments: {} },
    });
    await started;

    await transport.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7 },
    });
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    await transport.send({ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} });

    expect(transportErrors).toEqual([]);
    expect(received.at(-1)).toEqual({ jsonrpc: "2.0", id: 8, result: { tools: [] } });
  });
});
