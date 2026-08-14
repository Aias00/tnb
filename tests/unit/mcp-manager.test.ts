import { expect, test } from "bun:test";
import { pathToFileURL } from "node:url";

import type { JsonRpcMessage } from "../../src/services/mcp/client";
import { createLinkedMcpTransportPair } from "../../src/services/mcp/in-process";
import { connectMcpServers } from "../../src/services/mcp/manager";

test("MCP manager refreshes prompt snapshots after list_changed", async () => {
  const [clientTransport, serverTransport] = createLinkedMcpTransportPair();
  let promptName = "first";
  let resolveRefresh: (() => void) | undefined;
  const refreshed = new Promise<void>((resolve) => void (resolveRefresh = resolve));
  await serverTransport.start((message: JsonRpcMessage) => {
    if (!("id" in message) || !("method" in message)) return;
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { prompts: { listChanged: true } } }
      : message.method === "prompts/list"
        ? { prompts: [{ name: promptName }] }
        : {};
    void serverTransport.send({ jsonrpc: "2.0", id: message.id, result });
    if (message.method === "prompts/list" && promptName === "second") resolveRefresh?.();
  });
  const connections = await connectMcpServers(
    { mcpServers: {} },
    { cwd: process.cwd(), inProcess: { fixture: clientTransport } },
  );

  expect(connections.prompts.map((prompt) => prompt.name)).toEqual(["mcp__fixture__first"]);
  promptName = "second";
  await serverTransport.send({
    jsonrpc: "2.0",
    method: "notifications/prompts/list_changed",
  });
  await refreshed;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(connections.prompts.map((prompt) => prompt.name)).toEqual(["mcp__fixture__second"]);
  expect(connections.refreshErrors).toEqual({});

  await connections.close();
});

test("MCP manager refreshes tool and resource snapshots after list_changed", async () => {
  const [clientTransport, serverTransport] = createLinkedMcpTransportPair();
  let toolName = "first";
  let resourceUri = "memory://first";
  await serverTransport.start((message: JsonRpcMessage) => {
    if (!("id" in message) || !("method" in message)) return;
    const result = message.method === "initialize"
      ? {
          protocolVersion: "2025-11-25",
          capabilities: {
            tools: { listChanged: true },
            resources: { subscribe: true, listChanged: true },
          },
        }
      : message.method === "tools/list"
        ? { tools: [{ name: toolName, inputSchema: { type: "object" } }] }
        : message.method === "resources/list"
          ? { resources: [{ uri: resourceUri }] }
          : message.method === "resources/templates/list"
            ? { resourceTemplates: [] }
          : {};
    void serverTransport.send({ jsonrpc: "2.0", id: message.id, result });
  });
  const connections = await connectMcpServers(
    { mcpServers: {} },
    { cwd: process.cwd(), inProcess: { fixture: clientTransport } },
  );

  expect(connections.tools.map((tool) => tool.name)).toEqual([
    "mcp__fixture__first",
    "mcp__fixture__read_resource",
    "mcp__fixture__resource_updates",
  ]);
  toolName = "second";
  resourceUri = "memory://second";
  await serverTransport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  await serverTransport.send({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(connections.tools.map((tool) => tool.name)).toEqual([
    "mcp__fixture__second",
    "mcp__fixture__read_resource",
    "mcp__fixture__resource_updates",
  ]);
  expect(connections.tools[1]?.inputSchema).toEqual({
    type: "object",
    properties: {
      uri: {
        type: "string",
        description: "Exact resource URI to read",
        enum: ["memory://second"],
      },
      subscribe: {
        type: "boolean",
        description: "Subscribe to update notifications for this URI before reading it",
      },
    },
    required: ["uri"],
    additionalProperties: false,
  });

  toolName = "read_resource";
  await serverTransport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(connections.tools.map((tool) => tool.name)).toEqual([
    "mcp__fixture__second",
    "mcp__fixture__read_resource",
    "mcp__fixture__resource_updates",
  ]);
  expect(connections.refreshErrors["fixture:tools"]).toContain("Duplicate MCP tool name");

  toolName = "third";
  await serverTransport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(connections.tools.map((tool) => tool.name)).toEqual([
    "mcp__fixture__third",
    "mcp__fixture__read_resource",
    "mcp__fixture__resource_updates",
  ]);
  expect(connections.refreshErrors).toEqual({});

  await connections.clients.fixture?.subscribeResource("memory://second");
  await serverTransport.send({
    jsonrpc: "2.0",
    method: "notifications/resources/updated",
    params: { uri: "memory://second/child" },
  });
  expect(await connections.tools[2]?.execute(
    { clear: false },
    new AbortController().signal,
  )).toBe('{"updatedResources":["memory://second/child"]}');

  await connections.close();
});

test("MCP manager cancels elicitation during initialization before enabling the UI handler", async () => {
  const [clientTransport, serverTransport] = createLinkedMcpTransportPair();
  let initializationElicitation: unknown;
  let initializationRequestId: string | number | undefined;
  await serverTransport.start((message: JsonRpcMessage) => {
    if ("method" in message && "id" in message && message.method === "initialize") {
      initializationRequestId = message.id;
      void serverTransport.send({
        jsonrpc: "2.0",
        id: "startup-elicit",
        method: "elicitation/create",
        params: {
          message: "Need input during startup",
          requestedSchema: { type: "object", properties: {} },
        },
      });
      return;
    }
    if ("id" in message && !("method" in message) && message.id === "startup-elicit") {
      initializationElicitation = "result" in message ? message.result : message.error;
      void serverTransport.send({
        jsonrpc: "2.0",
        id: initializationRequestId!,
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
      });
      return;
    }
    if ("method" in message && "id" in message && message.method === "tools/list") {
      void serverTransport.send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
    }
  });
  let handlerCalls = 0;
  const connections = await connectMcpServers(
    { mcpServers: {} },
    {
      cwd: process.cwd(),
      inProcess: { fixture: clientTransport },
      elicitation: () => async () => {
        handlerCalls += 1;
        return { action: "accept" };
      },
    },
  );

  expect(initializationElicitation).toEqual({ action: "cancel" });
  expect(handlerCalls).toBe(0);
  await connections.close();
});

test("MCP manager surfaces URL elicitation completion notifications", async () => {
  const [clientTransport, serverTransport] = createLinkedMcpTransportPair();
  await serverTransport.start((message: JsonRpcMessage) => {
    if (!("method" in message) || !("id" in message)) return;
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }
      : message.method === "tools/list"
        ? { tools: [] }
        : {};
    void serverTransport.send({ jsonrpc: "2.0", id: message.id, result });
  });
  const completions: Array<{ serverName: string; elicitationId: string }> = [];
  const connections = await connectMcpServers(
    { mcpServers: {} },
    {
      cwd: process.cwd(),
      inProcess: { fixture: clientTransport },
      elicitationComplete(serverName, elicitationId) {
        completions.push({ serverName, elicitationId });
      },
    },
  );

  await serverTransport.send({
    jsonrpc: "2.0",
    method: "notifications/elicitation/complete",
    params: { elicitationId: "checkout-42" },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(completions).toEqual([{ serverName: "fixture", elicitationId: "checkout-42" }]);
  await connections.close();
});

test("MCP manager exposes the current workspace root and signals changes", async () => {
  const [clientTransport, serverTransport] = createLinkedMcpTransportPair();
  const clientMessages: JsonRpcMessage[] = [];
  await serverTransport.start((message: JsonRpcMessage) => {
    clientMessages.push(message);
    if (!("method" in message) || !("id" in message)) return;
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }
      : message.method === "tools/list"
        ? { tools: [] }
        : {};
    void serverTransport.send({ jsonrpc: "2.0", id: message.id, result });
  });
  let workspaceRoot = "/tmp/tnb-root-one";
  const connections = await connectMcpServers(
    { mcpServers: {} },
    {
      cwd: workspaceRoot,
      workspaceRoot: () => workspaceRoot,
      inProcess: { fixture: clientTransport },
    },
  );

  await serverTransport.send({ jsonrpc: "2.0", id: "roots-one", method: "roots/list" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(clientMessages).toContainEqual({
    jsonrpc: "2.0",
    id: "roots-one",
    result: { roots: [{ uri: pathToFileURL(workspaceRoot).href }] },
  });

  workspaceRoot = "/tmp/tnb-root-two";
  await connections.notifyRootsChanged();
  expect(clientMessages).toContainEqual({
    jsonrpc: "2.0",
    method: "notifications/roots/list_changed",
  });
  await serverTransport.send({ jsonrpc: "2.0", id: "roots-two", method: "roots/list" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(clientMessages).toContainEqual({
    jsonrpc: "2.0",
    id: "roots-two",
    result: { roots: [{ uri: pathToFileURL(workspaceRoot).href }] },
  });
  await connections.close();
});

test("MCP manager negotiates and filters legacy server logs", async () => {
  const [clientTransport, serverTransport] = createLinkedMcpTransportPair();
  const levels: string[] = [];
  await serverTransport.start((message: JsonRpcMessage) => {
    if (!("method" in message) || !("id" in message)) return;
    if (message.method === "logging/setLevel") {
      levels.push((message.params as { level: string }).level);
    }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {}, logging: {} } }
      : message.method === "tools/list"
        ? { tools: [] }
        : {};
    void serverTransport.send({ jsonrpc: "2.0", id: message.id, result });
  });
  const logs: unknown[] = [];
  const connections = await connectMcpServers(
    { mcpServers: {} },
    {
      cwd: process.cwd(),
      inProcess: { fixture: clientTransport },
      logging: (message) => {
        logs.push(message);
      },
    },
  );

  await serverTransport.send({
    jsonrpc: "2.0",
    method: "notifications/message",
    params: { level: "debug", data: "hidden" },
  });
  await serverTransport.send({
    jsonrpc: "2.0",
    method: "notifications/message",
    params: { level: "warning", logger: "worker", data: { message: "visible" } },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  expect(levels).toEqual(["info"]);
  expect(logs).toEqual([{
    serverName: "fixture",
    level: "warning",
    logger: "worker",
    data: { message: "visible" },
  }]);
  await connections.close();
});

test("MCP manager validates and surfaces progress and cancellation notifications", async () => {
  const [clientTransport, serverTransport] = createLinkedMcpTransportPair();
  await serverTransport.start((message: JsonRpcMessage) => {
    if (!("method" in message) || !("id" in message)) return;
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }
      : message.method === "tools/list"
        ? { tools: [] }
        : {};
    void serverTransport.send({ jsonrpc: "2.0", id: message.id, result });
  });
  const progress: unknown[] = [];
  const cancelled: unknown[] = [];
  const connections = await connectMcpServers(
    { mcpServers: {} },
    {
      cwd: process.cwd(),
      inProcess: { fixture: clientTransport },
      progress(event) {
        progress.push(event);
      },
      cancelled(event) {
        cancelled.push(event);
      },
    },
  );

  await serverTransport.send({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken: "tool-1", progress: 2, total: 5, message: "Indexing" },
  });
  await serverTransport.send({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken: "invalid", progress: "two" },
  });
  await serverTransport.send({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 9, reason: "Superseded" },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  expect(progress).toEqual([{
    serverName: "fixture",
    progressToken: "tool-1",
    progress: 2,
    total: 5,
    message: "Indexing",
  }]);
  expect(cancelled).toEqual([{
    serverName: "fixture",
    requestId: 9,
    reason: "Superseded",
  }]);
  await connections.close();
});
