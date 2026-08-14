import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../../src/services/session/storage";
import type { ConversationMessage } from "../../src/core/message";

const directories: string[] = [];
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "tnb-session-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const messages: ConversationMessage[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
  { role: "assistant", content: [{ type: "text", text: "hi" }] },
];

describe("JSONL session storage", () => {
  test("appends and restores messages for one project session", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const store = new SessionStore({ configDir, cwd, sessionId: "session-1" });

    await store.append(messages);

    expect(await store.read()).toEqual(messages);
    expect(store.filePath).toEndWith("session-1.jsonl");
  });

  test("deletes one exact session transcript", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const store = new SessionStore({ configDir, cwd, sessionId: "delete-me" });
    await store.append(messages);

    await store.delete();
    expect(await SessionStore.list({ configDir, cwd })).toEqual([]);
  });

  test("ignores only an unterminated trailing record left by an interrupted write", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const store = new SessionStore({ configDir, cwd, sessionId: "session-1" });
    await store.append(messages);
    await appendFile(store.filePath, '{"version":1,"type":"message"');

    expect(await store.read()).toEqual(messages);
  });

  test("rejects a malformed complete JSONL record", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const store = new SessionStore({ configDir, cwd, sessionId: "session-1" });
    await store.append(messages);
    await appendFile(store.filePath, "not-json\n");

    await expect(store.read()).rejects.toThrow("Invalid session record at line 3");
  });

  test("finds the most recently modified session for continue", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const older = new SessionStore({ configDir, cwd, sessionId: "older" });
    const newer = new SessionStore({ configDir, cwd, sessionId: "newer" });
    await older.append(messages);
    await newer.append(messages);
    await utimes(older.filePath, new Date(1_000), new Date(1_000));
    await utimes(newer.filePath, new Date(2_000), new Date(2_000));

    expect(await SessionStore.latestSessionId({ configDir, cwd })).toBe("newer");
  });

  test("lists historical user inputs for session picker previews", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const store = new SessionStore({ configDir, cwd, sessionId: "preview-session" });
    await store.append([
      ...messages,
      { role: "user", content: [{ type: "text", text: "configure provider" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);

    expect((await SessionStore.list({ configDir, cwd }))[0]?.userInputs).toEqual([
      "hello",
      "configure provider",
    ]);
  });

  test("restores from the latest compact boundary and subsequent messages", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const store = new SessionStore({ configDir, cwd, sessionId: "session-1" });
    await store.append(messages);
    const compacted: ConversationMessage[] = [
      { role: "user", content: [{ type: "text", text: "Conversation summary:\n\nEarlier work" }] },
      { role: "assistant", content: [{ type: "text", text: "I will continue from this summary." }] },
    ];
    await store.appendCompactBoundary({ messages: compacted, preTokens: 100, postTokens: 20 });
    const next: ConversationMessage = {
      role: "user",
      content: [{ type: "text", text: "next" }],
    };
    await store.append([next]);

    expect(await store.read()).toEqual([...compacted, next]);
    expect(await Bun.file(store.filePath).text()).toContain('"type":"compact_boundary"');
  });

  test("preserves active plan mode across a compact boundary", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const store = new SessionStore({ configDir, cwd, sessionId: "plan-session" });
    await store.appendCompactBoundary({
      messages,
      preTokens: 100,
      postTokens: 20,
      permissionMode: "plan",
      prePlanMode: "acceptEdits",
    });

    expect(await store.readState()).toEqual({
      messages,
      permissionMode: "plan",
      prePlanMode: "acceptEdits",
    });
  });

  test("persists and clears the active worktree state", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const store = new SessionStore({ configDir, cwd, sessionId: "worktree-session" });
    const worktree = {
      originalCwd: cwd,
      worktreePath: join(cwd, ".tnb", "worktrees", "feature"),
      worktreeName: "feature",
      worktreeBranch: "tnb-worktree-feature",
      originalHead: "0123456789abcdef",
    };

    await store.appendWorktreeState(worktree);
    expect((await store.readState()).worktree).toEqual(worktree);

    await store.appendWorktreeState(null);
    expect((await store.readState()).worktree).toBeUndefined();
  });

  test("persists and accumulates token usage and cost", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const store = new SessionStore({ configDir, cwd, sessionId: "usage-session" });

    await store.appendUsage({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 40,
      },
      costUsd: 0.001,
    });
    await store.appendUsage({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
      },
      costUsd: 0.0001,
    });

    expect((await store.readState()).usage).toEqual({
      inputTokens: 110,
      outputTokens: 22,
      cacheReadInputTokens: 33,
      cacheCreationInputTokens: 44,
      costUsd: 0.0011,
    });
  });

  test("stores a session title and forks conversation history under a new id", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const source = new SessionStore({ configDir, cwd, sessionId: "source-session" });
    await source.append(messages);
    await source.updateTopic({
      title: "Provider investigation",
      summary: "Compare provider request and streaming behavior.",
      strategicIntent: "Keep the Agent loop provider-neutral.",
    });
    await source.appendUsage({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      costUsd: 0.001,
    });

    const fork = await source.forkTo("forked-session");
    expect(await fork.readState()).toEqual({
      messages,
      title: "Provider investigation",
      summary: "Compare provider request and streaming behavior.",
      strategicIntent: "Keep the Agent loop provider-neutral.",
      parentSessionId: "source-session",
    });
    expect((await SessionStore.list({ configDir, cwd })).find(({ sessionId }) => sessionId === "forked-session")).toMatchObject({
      title: "Provider investigation",
      summary: "Compare provider request and streaming behavior.",
      strategicIntent: "Keep the Agent loop provider-neutral.",
      parentSessionId: "source-session",
    });
    await expect(source.forkTo("forked-session")).rejects.toMatchObject({ code: "EEXIST" });
  });
});
