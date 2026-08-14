import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../../src/services/session/storage";
import { createUpdateTopicTool } from "../../src/tools/topic";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("update topic tool", () => {
  test("persists title, summary, and strategic intent", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-topic-"));
    directories.push(root);
    const session = new SessionStore({ configDir: root, cwd: root, sessionId: "topic-session" });
    const tool = createUpdateTopicTool(session);
    const input = tool.validate({
      title: "Provider adapter",
      summary: "Implement and verify provider conversion.",
      strategic_intent: "Keep protocol differences outside the Agent loop.",
    });

    await tool.execute(input, new AbortController().signal);

    expect(await session.readState()).toEqual({
      messages: [],
      title: "Provider adapter",
      summary: "Implement and verify provider conversion.",
      strategicIntent: "Keep protocol differences outside the Agent loop.",
    });
  });

  test("requires at least one non-empty topic field", () => {
    const session = new SessionStore({ configDir: "/tmp", cwd: "/tmp", sessionId: "topic-session" });
    const tool = createUpdateTopicTool(session);
    expect(() => tool.validate({})).toThrow("requires title, summary, or strategic_intent");
    expect(() => tool.validate({ title: " " })).toThrow("must be a non-empty string");
  });
});
