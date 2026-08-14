import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadMcpConfig, loadMcpConfigInputs } from "../../src/services/mcp/config";

const directories: string[] = [];
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "tnb-mcp-config-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MCP config", () => {
  test("merges repeated CLI files and inline JSON with later entries winning", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "extra.json");
    await writeFile(path, JSON.stringify({
      mcpServers: {
        shared: { command: "first" },
        fileOnly: { command: "file" },
      },
    }));

    expect(await loadMcpConfigInputs([
      path,
      JSON.stringify({ mcpServers: { shared: { command: "second" }, inlineOnly: { command: "inline" } } }),
    ], directory)).toEqual({
      mcpServers: {
        shared: { command: "second" },
        fileOnly: { command: "file" },
        inlineOnly: { command: "inline" },
      },
    });
  });
  test("loads stdio server definitions", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "mcp.json");
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          local: { command: "bun", args: ["server.ts"], env: { TOKEN: "value" }, logLevel: "warning" },
        },
      }),
    );

    expect(await loadMcpConfig(path)).toEqual({
      mcpServers: {
        local: { command: "bun", args: ["server.ts"], env: { TOKEN: "value" }, logLevel: "warning" },
      },
    });
  });

  test("loads Streamable HTTP server definitions", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "mcp.json");
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            protocol: "auto",
            url: "https://mcp.example.test/rpc",
            headers: { authorization: "Bearer token" },
          },
        },
      }),
    );

    expect(await loadMcpConfig(path)).toEqual({
      mcpServers: {
        remote: {
          type: "http",
          protocol: "auto",
          url: "https://mcp.example.test/rpc",
          headers: { authorization: "Bearer token" },
        },
      },
    });
  });

  test("returns an empty config when the default file does not exist", async () => {
    const directory = await temporaryDirectory();
    expect(await loadMcpConfig(join(directory, "missing.json"))).toEqual({ mcpServers: {} });
  });

  test("rejects malformed server definitions", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "mcp.json");
    await writeFile(path, JSON.stringify({ mcpServers: { broken: { command: "", args: "no" } } }));

    await expect(loadMcpConfig(path)).rejects.toThrow("Invalid MCP server config: broken");
  });

  test("rejects an unknown logging level", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "mcp.json");
    await writeFile(path, JSON.stringify({
      mcpServers: { broken: { command: "bun", logLevel: "verbose" } },
    }));

    await expect(loadMcpConfig(path)).rejects.toThrow("Invalid MCP server config: broken");
  });

  test("rejects modern protocol mode on the deprecated SSE transport", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "mcp.json");
    await writeFile(path, JSON.stringify({
      mcpServers: {
        broken: { type: "sse", protocol: "2026-07-28", url: "https://mcp.example.test/sse" },
      },
    }));

    await expect(loadMcpConfig(path)).rejects.toThrow("Invalid MCP server config: broken");
  });
});
