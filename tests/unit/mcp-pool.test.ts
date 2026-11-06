import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connectMcpPool } from "../../src/services/mcp/pool";
import type { McpConfig } from "../../src/services/mcp/config";
test("MCP pool isolates failures, recovers one slot and retains a healthy connection after failed reconnect", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-mcp-pool-"));
  await writeFile(join(root, "version"), "fixture");
  const valid = { command: process.execPath, args: [resolve("tests/fixtures/durable-mcp-server.mjs"), join(root, "log"), join(root, "version")] };
  const config: McpConfig = { mcpServers: { good: { ...valid }, bad: { command: join(root, "missing") }, off: { ...valid, enabled: false } } };
  const pool = await connectMcpPool(config, { cwd: root, requestTimeoutMs: 500 });
  try {
    expect(pool.statuses.good?.state).toBe("connected"); expect(pool.statuses.bad?.state).toBe("failed"); expect(pool.statuses.off?.state).toBe("disabled");
    const good = pool.clients.good;
    config.mcpServers.bad = { ...valid }; await pool.reconnect("bad");
    expect(pool.statuses.bad?.state).toBe("connected"); expect(pool.clients.good).toBe(good);
    config.mcpServers.good = { command: join(root, "missing") };
    await expect(pool.reconnect("good")).rejects.toThrow();
    expect(pool.clients.good).toBe(good); expect(pool.statuses.good?.state).toBe("connected");
    expect(pool.tools.some(tool => tool.name === "mcp__good__inspect")).toBe(true);
  } finally { await pool.close(); await rm(root, { recursive: true, force: true }); }
  await expect(pool.reconnect("good")).rejects.toThrow("closed");
}, 20000);
