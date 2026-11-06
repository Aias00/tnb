import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/services/session/storage";
import { searchSessionHistory } from "../../src/services/session/history-search";
test("workspace history searches answers and tools beyond input indexes, with source and cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-history-full-"));
  try {
    const store = new SessionStore({ configDir: root, cwd: root, sessionId: "source" });
    await store.append([{ role: "user", content: [{ type: "text", text: "first" }] }, { role: "assistant", content: [{ type: "text", text: "answer UNIQUE_ANSWER" }] }, { role: "user", content: [{ type: "tool-result", toolUseId: "tool", content: "output UNIQUE_TOOL", isError: false }] }]);
    await store.appendCompactBoundary({ messages: [{ role: "user", content: [{ type: "text", text: "summary" }] }], preTokens: 100, postTokens: 10 });
    expect((await searchSessionHistory({ configDir: root, cwd: root, query: "UNIQUE_ANSWER" })).matches[0]?.role).toBe("assistant");
    expect((await searchSessionHistory({ configDir: root, cwd: root, query: "UNIQUE_TOOL" })).matches[0]).toMatchObject({ role: "tool", sessionId: "source" });
    expect((await searchSessionHistory({ configDir: root, cwd: join(root, "elsewhere"), query: "UNIQUE_TOOL" })).matches).toEqual([]);
    await expect(searchSessionHistory({ configDir: root, cwd: root, query: "x", signal: AbortSignal.abort() })).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
