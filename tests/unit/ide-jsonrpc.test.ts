import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { IdeJsonRpcClient } from "../../src/services/remote-control/ide-client";
import { runIdeCommand } from "../../src/services/remote-control/ide-command";
import { IdeJsonRpcBridge } from "../../src/services/remote-control/ide-jsonrpc";
import { serveRemoteControlSocket } from "../../src/services/remote-control/server";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("IDE JSON-RPC bridge", () => {
  test("opens workspace files and applies guarded LSP text edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-ide-"));
    roots.push(root);
    const file = join(root, "sample.ts");
    const source = "const value = 'old';\n";
    await writeFile(file, source);
    const output: string[] = [];
    const socket = { write: (value: string) => void output.push(value) } as unknown as Socket;
    const bridge = new IdeJsonRpcBridge({ cwd: root, ownerToken: "owner", query: async () => null });
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { ownerToken: "owner" } },
      { jsonrpc: "2.0", id: 2, method: "editor/openFile", params: { file: "sample.ts", line: 1, column: 1 } },
      {
        jsonrpc: "2.0", id: 3, method: "workspace/applyEdit", params: {
          expectedHashes: { "sample.ts": createHash("sha256").update(source).digest("hex") },
          changes: { "sample.ts": [{ range: { start: { line: 0, character: 15 }, end: { line: 0, character: 18 } }, newText: "new" }] },
        },
      },
      { jsonrpc: "2.0", id: 4, method: "editor/getContext" },
    ];
    await bridge.serve(socket, (async function* () {
      for (const request of requests) yield JSON.stringify(request);
    })());

    expect(await readFile(file, "utf8")).toBe("const value = 'new';\n");
    const responses = output.map((line) => JSON.parse(line));
    expect(responses[0].result.capabilities).toMatchObject({ applyWorkspaceEdit: true, openFile: true });
    const canonicalFile = await realpath(file);
    expect(responses[2].result).toEqual({ applied: true, files: [canonicalFile] });
    expect(responses[3].result).toMatchObject({ activeFile: canonicalFile, openFiles: [canonicalFile] });
  });

  test("rejects edits when the expected content hash no longer matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-ide-"));
    roots.push(root);
    const file = join(root, "sample.ts");
    await writeFile(file, "current\n");
    const output: string[] = [];
    const socket = { write: (value: string) => void output.push(value) } as unknown as Socket;
    const bridge = new IdeJsonRpcBridge({ cwd: root, ownerToken: "owner", query: async () => null });
    await bridge.serve(socket, (async function* () {
      yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { ownerToken: "owner" } });
      yield JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "workspace/applyEdit", params: {
          expectedHashes: { "sample.ts": "0".repeat(64) },
          changes: { "sample.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, newText: "changed" }] },
        },
      });
    })());

    expect(JSON.parse(output[1]!).error.message).toContain("changed");
    expect(await readFile(file, "utf8")).toBe("current\n");
  });

  test("accepts file events and replaces per-file diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-ide-"));
    roots.push(root);
    const file = join(root, "sample.ts");
    await writeFile(file, "const value = 1;\n");
    const output: string[] = [];
    const socket = { write: (value: string) => void output.push(value) } as unknown as Socket;
    const bridge = new IdeJsonRpcBridge({ cwd: root, ownerToken: "owner", query: async () => null });
    await bridge.serve(socket, (async function* () {
      yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { ownerToken: "owner" } });
      yield JSON.stringify({ jsonrpc: "2.0", id: 2, method: "workspace/didChangeFiles", params: { events: [{ file: "sample.ts", type: "changed" }] } });
      yield JSON.stringify({ jsonrpc: "2.0", id: 3, method: "textDocument/publishDiagnostics", params: {
        file: "sample.ts",
        diagnostics: [{ line: 1, column: 7, severity: "warning", message: "Example warning" }],
      } });
      yield JSON.stringify({ jsonrpc: "2.0", id: 4, method: "editor/getContext" });
    })());

    const responses = output.map((line) => JSON.parse(line));
    expect(responses[0].result.capabilities).toMatchObject({ fileEvents: true, publishDiagnostics: true, terminal: true });
    expect(responses[1].result.accepted).toBe(1);
    expect(responses[3].result.diagnostics).toMatchObject([{ file: await realpath(file), line: 1, severity: "warning" }]);
  });

  test("connects through the private discovery descriptor and multiplexes client requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-ide-"));
    roots.push(root);
    const socketPath = join(root, "editor.sock");
    const descriptorPath = `${socketPath}.json`;
    const file = join(root, "sample.ts");
    await writeFile(file, "export const answer = 42;\n");
    const controller = new AbortController();
    let ready: (() => void) | undefined;
    const readyPromise = new Promise<void>((resolveReady) => { ready = resolveReady; });
    const server = serveRemoteControlSocket({
      socketPath,
      descriptorPath,
      cwd: root,
      version: "0.1.0",
      signal: controller.signal,
      onReady: () => ready?.(),
      async handleConnection(socket, descriptor) {
        const lines = createInterface({ input: socket, crlfDelay: Infinity });
        try {
          await new IdeJsonRpcBridge({
            cwd: root,
            ownerToken: descriptor.ownerToken,
            query: async (prompt, context) => ({ prompt, activeFile: context.activeFile }),
          }).serve(socket, lines);
        } finally {
          lines.close();
        }
      },
    });
    await readyPromise;

    const client = await IdeJsonRpcClient.connect({ descriptorPath });
    try {
      expect(client.server.capabilities).toMatchObject({ agentQuery: true, terminal: true });
      const [opened, changed] = await Promise.all([
        client.openFile("sample.ts", 1, 8),
        client.didChangeFiles([{ file: "sample.ts", type: "changed" }]),
      ]);
      expect(opened).toMatchObject({ file: await realpath(file), line: 1, column: 8 });
      expect(changed.accepted).toBe(1);
      await client.publishDiagnostics("sample.ts", [{
        file: "sample.ts", line: 1, severity: "info", message: "Example diagnostic",
      }]);
      expect(await client.getContext()).toMatchObject({
        activeFile: await realpath(file),
        diagnostics: [{ file: await realpath(file), line: 1, message: "Example diagnostic" }],
      });
      expect(await client.query("Explain this file")).toMatchObject({
        prompt: "Explain this file", activeFile: await realpath(file),
      });
    } finally {
      client.close();
      controller.abort();
      await server;
    }
  });

  test("discovers and controls the workspace bridge through the ide CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-ide-cli-"));
    roots.push(root);
    const configDir = join(root, "config");
    const socketPath = join(configDir, "ide", "editor.sock");
    const descriptorPath = `${socketPath}.json`;
    const controller = new AbortController();
    let ready: (() => void) | undefined;
    const readyPromise = new Promise<void>((resolveReady) => { ready = resolveReady; });
    const server = serveRemoteControlSocket({
      socketPath,
      descriptorPath,
      cwd: root,
      version: "0.1.0",
      signal: controller.signal,
      onReady: () => ready?.(),
      async handleConnection(socket, descriptor) {
        const lines = createInterface({ input: socket, crlfDelay: Infinity });
        try {
          await new IdeJsonRpcBridge({
            cwd: root,
            ownerToken: descriptor.ownerToken,
            query: async (prompt, context, sessionId) => ({ prompt, sessionId, openFiles: context.openFiles }),
          }).serve(socket, lines);
        } finally {
          lines.close();
        }
      },
    });
    await readyPromise;

    try {
      const invoke = async (argv: string[]) => {
        let stdout = "";
        let stderr = "";
        const code = await runIdeCommand({
          argv,
          env: {},
          cwd: root,
          configDir,
          stdout: { write: (text) => void (stdout += text) },
          stderr: { write: (text) => void (stderr += text) },
        });
        return { code, stdout, stderr };
      };

      const list = await invoke(["ide", "list", "--json"]);
      expect(list.code).toBe(0);
      expect(JSON.parse(list.stdout)).toMatchObject([{ active: true, workspace: root, path: descriptorPath }]);
      expect(list.stdout).not.toContain("ownerToken");

      const status = await invoke(["ide", "status", "--json"]);
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ cwd: root, protocolVersion: "tnb.ide-jsonrpc/v1" });

      const context = await invoke(["ide", "context"]);
      expect(context.code).toBe(0);
      expect(JSON.parse(context.stdout)).toEqual({ openFiles: [], diagnostics: [] });

      const query = await invoke(["ide", "query", "Explain", "this", "workspace", "--session", "session-1"]);
      expect(query.code).toBe(0);
      expect(JSON.parse(query.stdout)).toEqual({
        prompt: "Explain this workspace",
        sessionId: "session-1",
        openFiles: [],
      });
    } finally {
      controller.abort();
      await server;
    }
  });
});
