import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { selectionReference, loadIdeSelection } from "../../src/services/remote-control/ide-selection";
import { IdeJsonRpcClient } from "../../src/services/remote-control/ide-client";
import { IdeJsonRpcBridge, type IdeEditorContext } from "../../src/services/remote-control/ide-jsonrpc";
import { serveRemoteControlSocket } from "../../src/services/remote-control/server";

const roots: string[] = [];
async function workspace() { const root = await mkdtemp(join(tmpdir(), "tnb-ide-reference-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("IDE snapshots respect line/column ranges and capture editor text without silently attaching a file", async () => {
  const root = await workspace(), file = join(root, "demo.ts"); await writeFile(file, "first\nsecond\nthird\n");
  const range = { file, startLine: 1, startColumn: 3, endLine: 2, endColumn: 4 };
  const reference = await selectionReference(root, range);
  expect(reference.label).toBe("demo.ts:1:3-2:4"); expect(reference.text).toContain("rst\nsec"); expect(reference.text).not.toContain("third");
  const unsaved = await selectionReference(root, { ...range, text: "unsaved editor selection" });
  expect(unsaved.text).toContain("unsaved editor selection");
  await expect(selectionReference(root, { ...range, endLine: 20 })).rejects.toThrow("outside");
  await expect(selectionReference(root, { ...range, text: "a".repeat(40000) })).rejects.toThrow("32 KiB");
});

test("IDE reference cannot escape workspace through a direct path or symlink", async () => {
  const root = await workspace(), other = await workspace(), external = join(other, "secret.txt"); await writeFile(external, "secret"); await symlink(external, join(root, "link.txt"));
  for (const file of [external, join(root, "link.txt")]) await expect(selectionReference(root, { file, startLine: 1, endLine: 1, startColumn: 1, endColumn: 3, text: "secret" })).rejects.toThrow();
});

test("authenticated editor and TUI connections share only their host's published selection", async () => {
  const root = await workspace(), file = join(root, "demo.ts"); await writeFile(file, "original\n");
  const controller = new AbortController(); const descriptorPath = join(root, "ide", "editor.sock.json");
  const state = { value: { openFiles: [], diagnostics: [] } as IdeEditorContext };
  const ready = Promise.withResolvers<void>();
  const server = serveRemoteControlSocket({ socketPath: join(root, "ide", "editor.sock"), descriptorPath, cwd: root, version: "0.1.0", signal: controller.signal, onReady: () => ready.resolve(),
    async handleConnection(socket, descriptor) { const lines = createInterface({ input: socket, crlfDelay: Infinity }); try { await new IdeJsonRpcBridge({ cwd: root, ownerToken: descriptor.ownerToken, contextState: state, query: async () => null }).serve(socket, lines); } finally { lines.close(); } },
  });
  let editor: IdeJsonRpcClient | undefined;
  try {
    await ready.promise; editor = await IdeJsonRpcClient.connect({ descriptorPath });
    await editor.updateContext({ selection: { file, startLine: 1, startColumn: 1, endLine: 1, endColumn: 4, text: "selected unsaved" } });
    expect((await loadIdeSelection(root, descriptorPath)).text).toContain("selected unsaved");
    await expect(loadIdeSelection(await workspace(), descriptorPath)).rejects.toThrow("outside");
  } finally { editor?.close(); controller.abort(); await server; }
});
