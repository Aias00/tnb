import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInteractiveSlashCommand } from "../../src/entrypoints/cli";
import { SessionStore } from "../../src/services/session/storage";
import { fileChangeEvidence } from "../../src/services/git/change-evidence";
import type { SlashCommandName } from "../../src/ui/slash-commands";

test("inspection commands use recorded evidence, search pre-compaction inputs and load previews only on demand", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-inspection-"));
  const context = { configDir: root, cwd: root } as Parameters<typeof runInteractiveSlashCommand>[1];
  const command = (name: SlashCommandName, argument = "") => runInteractiveSlashCommand({ name, invokedAs: name, argument, sessionId: "inspect", nextSessionId: "next" }, context);
  try {
    expect((await command("changes")).management?.items).toEqual([]);
    expect((await command("compactions")).management?.items).toEqual([]);
    const store = new SessionStore({ configDir: root, cwd: root, sessionId: "inspect" });
    await store.append([{ role: "user", content: [{ type: "text", text: "middle MATCH_ME" }] }, { role: "user", content: [{ type: "tool-result", toolUseId: "write", content: "wrote", isError: false, fileChanges: [fileChangeEvidence("file.txt", "original", "changed")] }] }]);
    await store.appendCompactBoundary({ messages: [{ role: "user", content: [{ type: "text", text: "Conversation summary: done" }] }], preTokens: 5000, postTokens: 500 });
    expect((await command("history", "match_me")).management?.items[0]?.draftText).toBe("middle MATCH_ME");
    const change = (await command("changes", "1")).management?.items[0];
    expect(change?.diffPreview).toContain("-original"); expect(change?.diffPreview).toContain("+changed");
    expect((await command("compactions")).management?.items[0]?.description).toContain("5,000 → 500");
    const session = (await command("sessions")).management?.items[0]; expect(session?.transcriptPreview).toBeUndefined(); expect(session?.inspectCommand).toBe("/session-preview inspect");
    expect((await command("session-preview", "inspect")).management?.items[0]?.transcriptPreview?.length).toBeGreaterThan(0);
    const calls: string[] = []; context.reconnectMcp = async name => { calls.push(name); };
    await command("mcp", "reconnect one"); expect(calls).toEqual(["one"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
