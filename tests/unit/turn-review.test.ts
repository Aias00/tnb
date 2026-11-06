import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileChangeEvidence } from "../../src/services/git/change-evidence";
import { reviewTurns } from "../../src/services/git/turn-review";
import { createWriteTool } from "../../src/tools/builtins";
import { executeTool } from "../../src/core/tool-runtime";

test("successful atomic writes persist exact evidence in native tool results; shell results stay unattributed", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tnb-change-")));
  try {
    const result = await executeTool({ type: "tool-use", id: "write", name: "write", input: { path: "new.txt", content: "actual\n" } }, { prompt: "write", model: "fixture", transport: { async *stream() {} }, tools: [createWriteTool(root)], authorize: async () => ({ behavior: "allow" }) }, new AbortController().signal);
    expect(result.result.fileChanges?.[0]).toMatchObject({ path: join(root, "new.txt"), before: null, after: "actual\n", truncated: false });
    const { SessionStore } = await import("../../src/services/session/storage");
    const session = new SessionStore({ configDir: root, cwd: root, sessionId: "evidence" });
    await session.append([{ role: "user", content: [{ type: "text", text: "write" }] }, { role: "user", content: [result.result] }]);
    expect((await session.audit()).messages[1]!.content[0]).toHaveProperty("fileChanges");
    const denied = await executeTool({ type: "tool-use", id: "denied", name: "write", input: { path: "denied.txt", content: "no" } }, { prompt: "no", model: "fixture", transport: { async *stream() {} }, tools: [createWriteTool(root)], authorize: async () => ({ behavior: "deny", message: "denied" }) }, new AbortController().signal);
    expect(denied.result.fileChanges).toBeUndefined();
    const turns = reviewTurns([{ role: "user", content: [{ type: "text", text: "write" }] }, { role: "user", content: [result.result] }, { role: "assistant", content: [{ type: "tool-use", id: "shell", name: "bash", input: {} }] }, { role: "user", content: [{ type: "tool-result", toolUseId: "shell", content: "done", isError: false }] }]);
    expect(turns[0]?.changes).toHaveLength(1); expect(turns[0]?.unattributed).toBe(1);
    const bounded = fileChangeEvidence("large", "a".repeat(40000), "new"); expect(bounded.truncated).toBe(true); expect(bounded.before).toBeUndefined(); expect(bounded.afterHash).toHaveLength(64);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review snapshots never enter model context or inflate compaction token estimates", async () => {
  const { withoutFileChangeEvidence } = await import("../../src/core/message");
  const { estimateConversationTokens } = await import("../../src/services/compact/compact");
  const messages: import("../../src/core/message").ConversationMessage[] = [{ role: "user", content: [{ type: "tool-result", toolUseId: "edit", content: "Edited file", isError: false, fileChanges: [fileChangeEvidence("file", "SECRET_BEFORE", "SECRET_AFTER")] }] }];
  const clean = withoutFileChangeEvidence(messages);
  expect(JSON.stringify(clean)).not.toContain("SECRET"); expect(messages[0]!.content[0]).toHaveProperty("fileChanges");
  expect(estimateConversationTokens(messages)).toBe(estimateConversationTokens(clean));
});
