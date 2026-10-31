import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/entrypoints/cli";
import { createLinkedMcpTransportPair } from "../../src/services/mcp/in-process";
import { connectMcpServers } from "../../src/services/mcp/manager";
import type { JsonRpcMessage } from "../../src/services/mcp/client";
import type { ModelTransport } from "../../src/providers/types";

test("MCP list refresh reaches the next main-agent request and preserves in-flight handlers", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-mcp-runtime-"));
  const [clientTransport, serverTransport] = createLinkedMcpTransportPair();
  let name = "first";
  const calls: string[] = [];
  await serverTransport.start((message: JsonRpcMessage) => {
    if (!("id" in message) || !("method" in message)) return;
    let result: unknown = {};
    if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } } };
    if (message.method === "tools/list") result = { tools: [{ name, description: name, inputSchema: { type: "object" } }] };
    if (message.method === "tools/call") { calls.push((message.params as { name: string }).name); result = { content: [{ type: "text", text: "ok" }] }; }
    void serverTransport.send({ jsonrpc: "2.0", id: message.id, result });
  });
  const connections = await connectMcpServers({ mcpServers: {} }, { cwd: root, inProcess: { fixture: clientTransport } });
  let requests = 0;
  const transport: ModelTransport = { async *stream(request) {
    requests++;
    if (requests === 1) {
      expect(request.tools.some((t) => t.name === "mcp__fixture__first")).toBe(true);
      name = "second";
      await connections.refresh("fixture", "tools");
      yield { type: "tool-start", index: 0, id: "first-call", name: "mcp__fixture__first" };
      yield { type: "tool-input", index: 0, json: "{}" };
      yield { type: "response-end", reason: "tool-use" };
    } else {
      expect(request.tools.some((t) => t.name === "mcp__fixture__second")).toBe(true);
      expect(request.tools.some((t) => t.name === "mcp__fixture__first")).toBe(false);
      yield { type: "text", index: 0, text: "done" };
      yield { type: "response-end", reason: "end-turn" };
    }
  } };
  let errors = "";
  try {
    expect(await runCli({ argv: ["-p", "act", "--permission-mode", "bypass"], env: {}, cwd: root, configDir: join(root, "config"),
      transport, mcpConnections: connections, stdout: { write: () => {} }, stderr: { write: (text) => { errors += text; } },
    }), errors).toBe(0);
    expect(requests).toBe(2);
    expect(calls).toEqual(["first"]);
  } finally { await connections.close(); await rm(root, { recursive: true, force: true }); }
});
