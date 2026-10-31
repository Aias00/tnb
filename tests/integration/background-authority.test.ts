import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/entrypoints/cli";
import type { ConversationMessage } from "../../src/core/message";
import type { ModelEvent, ModelRequest, ModelTransport } from "../../src/providers/types";
import { TaskManager } from "../../src/services/tasks/manager";
import { HookRunner } from "../../src/services/hooks/runner";
import { SessionStore } from "../../src/services/session/storage";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const usage = (inputTokens: number): ModelEvent => ({ type: "usage", usage: { inputTokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
const text = (request: ModelRequest) => request.messages.flatMap((message): ConversationMessage["content"][number][] => message.content).filter((block) => block.type === "text").map((block) => block.text).join("\n");

test("a retained background activation observes the next turn's plan mode and keeps its own Hook billing", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-background-authority-"));
  const configDir = join(root, "config"); await mkdir(configDir);
  const tasks = new TaskManager(join(root, "tasks.json")); await tasks.initialize();
  const hooks = new HookRunner({ cwd: root, sessionId: "background-session", env: {}, hooks: {
    TaskCompleted: [{ hooks: [{ type: "prompt", prompt: "bill-background-completion-hook" }] }],
    SubagentStop: [{ hooks: [{ type: "prompt", prompt: "bill-background-stop-hook" }] }],
  } });
  const started = deferred(); const resume = deferred();
  let writeOutcome = ""; let originHookCalls = 0; let nextTurnHookCalls = 0; let rootCalls = 0;
  const origin: ModelTransport = { async *stream(request): AsyncGenerator<ModelEvent> {
    if (text(request).startsWith("bill-background-")) {
      originHookCalls++; yield usage(10);
      yield { type: "text", index: 0, text: '{"ok":true}' };
    } else if (text(request).includes("isolated-background-briefing")) {
      const outcome = request.messages.flatMap((message): ConversationMessage["content"][number][] => message.content).find((block) => block.type === "tool-result" && block.toolUseId === "child-write");
      if (outcome?.type === "tool-result") {
        writeOutcome = outcome.content;
        yield { type: "text", index: 0, text: "child complete" };
      } else {
        started.resolve(); await resume.promise;
        yield usage(10);
        yield { type: "tool-start", index: 0, id: "child-write", name: "write" };
        yield { type: "tool-input", index: 0, json: JSON.stringify({ path: "should-not-exist", content: "forbidden in plan" }) };
        yield { type: "response-end", reason: "tool-use" }; return;
      }
    } else if (++rootCalls === 1) {
      yield { type: "tool-start", index: 0, id: "delegate", name: "agent" };
      yield { type: "tool-input", index: 0, json: JSON.stringify({ description: "background", prompt: "isolated-background-briefing", run_in_background: true }) };
      yield { type: "response-end", reason: "tool-use" }; return;
    } else yield { type: "text", index: 0, text: "parent returned" };
    yield { type: "response-end", reason: "end-turn" };
  } };
  const next: ModelTransport = { async *stream(request) {
    if (text(request).startsWith("bill-background-")) nextTurnHookCalls++;
    yield usage(20);
    yield { type: "text", index: 0, text: "next turn complete" };
    yield { type: "response-end", reason: "end-turn" };
  } };
  let errors = "";
  const common = { cwd: root, configDir, env: {}, taskManager: tasks, hookRunner: hooks,
    sessionIdFactory: () => "background-session", stdout: { write() {} }, stderr: { write(value: string) { errors += value; } } };
  try {
    expect(await runCli({ ...common, transport: origin, argv: ["-p", "launch", "--yolo", "--max-budget-usd", "1"] }), errors).toBe(0);
    await started.promise;
    expect(tasks.list().find((task) => task.type === "agent")?.status).toBe("running");
    expect(await runCli({ ...common, transport: next, argv: ["-p", "plan next", "--resume", "background-session", "--permission-mode", "plan"] }), errors).toBe(0);
    resume.resolve();
    const deadline = Date.now() + 3000;
    while (tasks.list().some((task) => task.status === "running") && Date.now() < deadline) await Bun.sleep(10);
    expect(tasks.list().find((task) => task.type === "agent")?.status).toBe("completed");
    expect(await Bun.file(join(root, "should-not-exist")).exists()).toBe(false);
    expect(writeOutcome).toContain("plan mode");
    expect(originHookCalls).toBe(2);
    expect(nextTurnHookCalls).toBe(0);
    const session = await new SessionStore({ cwd: root, configDir, sessionId: "background-session" }).readState();
    expect(session.usage?.inputTokens).toBe(50);
  } finally {
    resume.resolve(); await tasks.shutdown(); await hooks.end("other");
    await rm(root, { recursive: true, force: true });
  }
});
