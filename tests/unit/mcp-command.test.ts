import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMcpCommand } from "../../src/services/mcp/command";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ configDir: string; serverPath: string }> {
  const configDir = await mkdtemp(join(tmpdir(), "tnb-mcp-command-"));
  directories.push(configDir);
  const serverPath = join(configDir, "server.ts");
  await writeFile(
    serverPath,
    [
      'import { createInterface } from "node:readline";',
      'const lines = createInterface({ input: process.stdin });',
      'lines.on("line", (line) => {',
      '  const message = JSON.parse(line);',
      '  if (!("id" in message)) return;',
      '  let result = {};',
      '  if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { resources: { subscribe: true }, completions: {} } };',
      '  if (message.method === "resources/list") result = { resources: [] };',
      '  if (message.method === "resources/templates/list") result = { resourceTemplates: [{ uriTemplate: "memory://notes/{name}", name: "Notes" }] };',
      '  if (message.method === "completion/complete") result = { completion: { values: [`${message.params.argument.value}in`], total: 1, hasMore: false } };',
      '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");',
      '  if (message.method === "resources/subscribe") setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: `${message.params.uri}/child` } }) + "\\n"), 0);',
      '});',
    ].join("\n"),
  );
  await writeFile(
    join(configDir, "mcp.json"),
    JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [serverPath] } } }),
  );
  return { configDir, serverPath };
}

test("MCP command lists resource templates", async () => {
  const { configDir } = await fixture();
  let stdout = "";

  expect(await runMcpCommand({
    argv: ["mcp", "templates", "fixture"],
    env: {},
    cwd: process.cwd(),
    configDir,
    stdout: { write: (text) => void (stdout += text) },
    stderr: { write: () => undefined },
  })).toBe(0);
  expect(JSON.parse(stdout)).toEqual([
    { uriTemplate: "memory://notes/{name}", name: "Notes" },
  ]);
});

test("MCP command watches resource updates until aborted", async () => {
  const { configDir } = await fixture();
  const controller = new AbortController();
  let stdout = "";

  expect(await runMcpCommand({
    argv: ["mcp", "watch", "fixture", "memory://notes/current"],
    env: {},
    cwd: process.cwd(),
    configDir,
    signal: controller.signal,
    stdout: {
      write(text) {
        stdout += text;
        if (text.includes("memory://notes/current/child")) controller.abort();
      },
    },
    stderr: { write: () => undefined },
  })).toBe(0);
  expect(stdout).toContain('"subscribed":"memory://notes/current"');
  expect(stdout).toContain('"uri":"memory://notes/current/child"');
});

test("MCP command requests resource-template argument completions", async () => {
  const { configDir } = await fixture();
  let stdout = "";

  expect(await runMcpCommand({
    argv: [
      "mcp",
      "complete",
      "fixture",
      "resource",
      "memory://notes/{name}",
      "name",
      "ma",
      '{"scope":"team"}',
    ],
    env: {},
    cwd: process.cwd(),
    configDir,
    stdout: { write: (text) => void (stdout += text) },
    stderr: { write: () => undefined },
  })).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ values: ["main"], total: 1, hasMore: false });
});
