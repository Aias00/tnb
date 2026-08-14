import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SubagentTranscript } from "../../src/services/session/subagent-transcript";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("subagent transcript recovery", () => {
  test("restores completed history and removes an interrupted trailing tool call", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-subagent-"));
    roots.push(root);
    const transcript = new SubagentTranscript({ projectDir: root, sessionId: "session", agentId: "agent" });
    await transcript.append({ role: "user", content: [{ type: "text", text: "inspect the project" }] });
    await transcript.append({ role: "assistant", content: [
      { type: "text", text: "I found the target." },
      { type: "tool-use", id: "tool-1", name: "read", input: { path: "src/main.ts" } },
    ] });

    expect(await transcript.read()).toEqual([
      { role: "user", content: [{ type: "text", text: "inspect the project" }] },
      { role: "assistant", content: [{ type: "text", text: "I found the target." }] },
    ]);
  });

  test("ignores only an unterminated crash tail and rejects malformed complete records", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-subagent-"));
    roots.push(root);
    const transcript = new SubagentTranscript({ projectDir: root, sessionId: "session", agentId: "agent" });
    await transcript.append({ role: "user", content: [{ type: "text", text: "continue" }] });
    await appendFile(transcript.filePath, '{"version":1,"timestamp":"interrupted"');
    expect(await transcript.read()).toHaveLength(1);

    await appendFile(transcript.filePath, "\n{not-json}\n");
    await expect(transcript.read()).rejects.toThrow();
  });

  test("coalesces recovery prompts into the preceding user turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-subagent-"));
    roots.push(root);
    const transcript = new SubagentTranscript({ projectDir: root, sessionId: "session", agentId: "agent" });
    await transcript.append({ role: "user", content: [{ type: "text", text: "original task" }] });
    await transcript.append({ role: "user", content: [{ type: "text", text: "resume after interruption" }] });
    expect(await transcript.read()).toEqual([{ role: "user", content: [
      { type: "text", text: "original task" },
      { type: "text", text: "resume after interruption" },
    ] }]);
  });
});
