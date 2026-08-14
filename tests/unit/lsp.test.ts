import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";

import { TnbLspMessageDecoder, encodeTnbLspMessage } from "../../src/services/lsp/jsonrpc";
import { TnbLspManager } from "../../src/services/lsp/manager";
import { createLspTool } from "../../src/tools/lsp";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LSP support", () => {
  test("encodes and decodes JSON-RPC frames with Content-Length headers", () => {
    const decoder = new TnbLspMessageDecoder();
    const frameA = encodeTnbLspMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const frameB = encodeTnbLspMessage({ jsonrpc: "2.0", method: "window/logMessage", params: { message: "你好" } });
    const outputA = decoder.push(frameA.subarray(0, 12));
    const outputB = decoder.push(Buffer.concat([Buffer.from(frameA.subarray(12)), Buffer.from(frameB)]));

    expect(outputA).toEqual([]);
    expect(outputB).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
      { jsonrpc: "2.0", method: "window/logMessage", params: { message: "你好" } },
    ]);
  });

  test("manages server lifecycle and exposes diagnostics plus code intelligence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-lsp-"));
    roots.push(root);
    const workspaceFile = join(root, "sample.ts");
    const exitFile = join(root, "server-exit.txt");
    const serverFile = join(root, "fake-lsp.mjs");
    await writeFile(workspaceFile, "const value = 1;\nvalue;\n", "utf8");
    await writeFile(serverFile, fakeServerSource(exitFile), "utf8");

    const manager = new TnbLspManager(root, [{
      name: "fake-ts",
      command: process.execPath,
      args: [serverFile],
      selectors: [{ languageId: "typescript", extensions: [".ts"] }],
      traceStderr: false,
    }]);

    const diagnostics = await manager.diagnosticsForFile(workspaceFile, { waitMs: 1_000 });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.diagnostics[0]?.message).toBe("Fake diagnostic");

    expect(await manager.hover(workspaceFile, { line: 1, character: 0 })).toMatchObject({
      contents: "Hover info for sample.ts",
    });

    expect(await manager.definition(workspaceFile, { line: 1, character: 0 })).toEqual([
      expect.objectContaining({ filePath: realpathSync(workspaceFile), startLine: 0, startCharacter: 6 }),
    ]);

    expect(await manager.references(workspaceFile, { line: 1, character: 0 })).toHaveLength(2);
    expect(await manager.documentSymbols(workspaceFile)).toEqual([
      expect.objectContaining({ name: "value", kind: 13 }),
    ]);
    expect(await manager.implementation(workspaceFile, { line: 1, character: 0 })).toEqual([
      expect.objectContaining({ filePath: realpathSync(workspaceFile), startLine: 0 }),
    ]);
    expect(await manager.workspaceSymbols("value")).toEqual([
      expect.objectContaining({ name: "value", kind: 13 }),
    ]);
    expect(await manager.callHierarchy(workspaceFile, { line: 1, character: 0 }, "incoming")).toEqual([
      expect.objectContaining({ filePath: realpathSync(workspaceFile), startLine: 0 }),
    ]);

    await manager.close();
    expect(await readFile(exitFile, "utf8")).toContain("closed");
  });

  test("wraps manager operations in the LSP tool interface", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-lsp-tool-"));
    roots.push(root);
    const workspaceFile = join(root, "sample.ts");
    const serverFile = join(root, "fake-lsp.mjs");
    await writeFile(workspaceFile, "const value = 1;\nvalue;\n", "utf8");
    await writeFile(serverFile, fakeServerSource(join(root, "server-exit.txt")), "utf8");

    const manager = new TnbLspManager(root, [{
      name: "fake-ts",
      command: process.execPath,
      args: [serverFile],
      selectors: [{ languageId: "typescript", extensions: [".ts"] }],
      traceStderr: false,
    }]);
    const tool = createLspTool({
      workspaceRoot: root,
      managerForRoot: () => manager,
    });

    const diagnosticsInput = tool.validate({
      operation: "diagnostics",
      path: "sample.ts",
      waitMs: 1_000,
    });
    expect(await tool.execute(diagnosticsInput, new AbortController().signal)).toContain("Fake diagnostic");

    const hoverInput = tool.validate({
      operation: "hover",
      path: "sample.ts",
      line: 2,
      character: 1,
    });
    expect(await tool.execute(hoverInput, new AbortController().signal)).toContain("Hover info for sample.ts");

    const definitionInput = tool.validate({
      operation: "definition",
      path: "sample.ts",
      line: 2,
      character: 1,
    });
    expect(await tool.execute(definitionInput, new AbortController().signal)).toContain(`${workspaceFile}:1:7`);
    await manager.close();
  });
});

function fakeServerSource(exitFile: string): string {
  return `
import { writeFileSync } from "node:fs";
import { basename } from "node:path";

let buffer = Buffer.alloc(0);
let initialized = false;
let openedUri;

process.on("exit", () => {
  writeFileSync(${JSON.stringify(exitFile)}, "closed\\n", "utf8");
});

process.stdin.on("data", (chunk) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) break;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const contentLengthLine = header.split("\\r\\n").find((line) => line.toLowerCase().startsWith("content-length:"));
    const length = Number.parseInt(contentLengthLine.split(":")[1].trim(), 10);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.length < end) break;
    const body = JSON.parse(buffer.subarray(start, end).toString("utf8"));
    buffer = buffer.subarray(end);
    handle(body);
  }
});

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(Buffer.concat([
    Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n", "utf8"),
    body,
  ]));
}

function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities: {
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          documentSymbolProvider: true,
          implementationProvider: true,
          workspaceSymbolProvider: true,
          callHierarchyProvider: true,
        },
      },
    });
    return;
  }
  if (message.method === "initialized") {
    initialized = true;
    return;
  }
  if (!initialized) return;
  if (message.method === "textDocument/didOpen") {
    const uri = message.params.textDocument.uri;
    openedUri = uri;
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri,
        version: 1,
        diagnostics: [{
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 11 },
          },
          severity: 2,
          message: "Fake diagnostic",
          source: "fake-ts",
        }],
      },
    });
    return;
  }
  if (message.method === "textDocument/hover") {
    const uri = message.params.textDocument.uri;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        contents: { kind: "markdown", value: "Hover info for " + basename(new URL(uri).pathname) },
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 5 },
        },
      },
    });
    return;
  }
  if (message.method === "textDocument/definition") {
    const uri = message.params.textDocument.uri;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: [{
        uri,
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
      }],
    });
    return;
  }
  if (message.method === "textDocument/implementation") {
    const uri = message.params.textDocument.uri;
    send({ jsonrpc: "2.0", id: message.id, result: [{ uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } } }] });
    return;
  }
  if (message.method === "textDocument/references") {
    const uri = message.params.textDocument.uri;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: [{
        uri,
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
      }, {
        uri,
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 5 },
        },
      }],
    });
    return;
  }
  if (message.method === "textDocument/documentSymbol") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: [{
        name: "value",
        kind: 13,
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
        selectionRange: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
      }],
    });
    return;
  }
  if (message.method === "workspace/symbol") {
    send({ jsonrpc: "2.0", id: message.id, result: [{ name: "value", kind: 13, location: { uri: openedUri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } } } }] });
    return;
  }
  if (message.method === "textDocument/prepareCallHierarchy") {
    const uri = message.params.textDocument.uri;
    send({ jsonrpc: "2.0", id: message.id, result: [{ name: "value", kind: 12, uri, range: { start: { line: 0, character: 0 }, end: { line: 1, character: 5 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } } }] });
    return;
  }
  if (message.method === "callHierarchy/incomingCalls" || message.method === "callHierarchy/outgoingCalls") {
    const item = message.params.item;
    send({ jsonrpc: "2.0", id: message.id, result: [message.method.endsWith("incomingCalls") ? { from: item, fromRanges: [item.selectionRange] } : { to: item, fromRanges: [item.selectionRange] }] });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "exit") {
    process.exit(0);
  }
}
`;
}
