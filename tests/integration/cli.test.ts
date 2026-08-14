import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createResumeManagement, parseArguments, prepareInteractiveSession, runCli, runInteractiveCli, runModelsCli, runStreamJsonCli } from "../../src/entrypoints/cli";
import type { ConversationMessage } from "../../src/core/message";
import type { ModelEvent, ModelRequest, ModelTransport } from "../../src/providers/types";
import { ProviderHttpError } from "../../src/providers/retry";
import { SessionStore } from "../../src/services/session/storage";
import { listManagedWorktreeJobs } from "../../src/services/worktree/manager";

class ScriptedTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly responses: ModelEvent[][]) {}
  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    this.requests.push(structuredClone(request));
    const response = this.responses[this.requests.length - 1];
    if (!response) throw new Error("Scripted transport ran out of responses");
    yield* response;
  }
}

const directories: string[] = [];
async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), "tnb-cli-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function toolTurn(name: string, input: unknown): ModelEvent[][] {
  return [
    [
      { type: "tool-start", index: 0, id: "call-1", name },
      { type: "tool-input", index: 0, json: JSON.stringify(input) },
      { type: "response-end", reason: "tool-use" },
    ],
    [
      { type: "text", index: 0, text: "Done" },
      { type: "response-end", reason: "end-turn" },
    ],
  ];
}

describe("tnb session arguments", () => {
  test("opens the session picker for bare --resume in interactive mode", () => {
    const parsed = parseArguments(["-p", "__interactive__", "--resume"], {}, { allowBareResume: true });
    expect(parsed.resumePicker).toBe(true);
    expect(parsed.resume).toBeUndefined();
  });

  test("supports the -r alias with an explicit session ID", () => {
    expect(parseArguments(["-p", "hello", "-r", "session-123"], {})).toMatchObject({
      resume: "session-123",
      resumePicker: false,
    });
  });

  test("requires an explicit resume ID outside interactive picker mode", () => {
    expect(() => parseArguments(["-p", "hello", "--resume"], {})).toThrow("--resume requires a value");
    expect(() => parseArguments(["-p", "hello", "-r"], {})).toThrow("-r requires a value");
  });

  test("loads an explicit interactive resume before entering the TUI", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const session = new SessionStore({ configDir, cwd, sessionId: "resume-direct" });
    await session.append([
      { role: "user", content: [{ type: "text", text: "first request" }] },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    ]);

    const prepared = await prepareInteractiveSession({
      parsed: parseArguments(["-p", "__interactive__", "--resume", "resume-direct"], {}),
      configDir,
      cwd,
      sessionIdFactory: () => "new-session",
    });

    expect(prepared.sessionId).toBe("resume-direct");
    expect(prepared.resume).toBe(true);
    expect(prepared.state?.messages).toHaveLength(2);
  });

  test("builds a compact resume picker without loading the full transcript", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const session = new SessionStore({ configDir, cwd, sessionId: "resume-preview" });
    await session.append([
      { role: "user", content: [{ type: "text", text: "first request" }] },
      { role: "assistant", content: [{ type: "text", text: "x".repeat(20_000) }] },
      { role: "user", content: [{ type: "text", text: "latest request" }] },
      { role: "assistant", content: [{ type: "tool-use", id: "tool-1", name: "bash", input: { command: "printf large" } }] },
      { role: "user", content: [{ type: "tool-result", toolUseId: "tool-1", content: "y".repeat(20_000), isError: false }] },
    ]);

    const picker = await createResumeManagement(configDir, cwd);

    expect(picker.items).toHaveLength(1);
    expect(picker.items[0]?.preview).toEqual(["first request", "latest request"]);
    expect(picker.items[0]?.transcriptPreview).toBeUndefined();
  });
});

describe("tnb print mode", () => {
  test("processes multiple stream-json user records in one persistent session", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const transport = new ScriptedTransport([
      [{ type: "text", index: 0, text: "first" }, { type: "response-end", reason: "end-turn" }],
      [{ type: "text", index: 0, text: "second" }, { type: "response-end", reason: "end-turn" }],
    ]);
    let stdout = "";
    async function* input() {
      yield JSON.stringify({ type: "user", prompt: "hello" });
      yield JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "continue" }] } });
    }

    expect(await runStreamJsonCli({
      argv: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--replay-user-messages"],
      env: {},
      cwd,
      configDir,
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: () => undefined },
      transport,
      input: input(),
      sessionIdFactory: () => "stream-input-session",
    })).toBe(0);

    const records = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toEqual({ type: "system", subtype: "init", session_id: "stream-input-session" });
    expect(records.filter(({ type }) => type === "user")).toHaveLength(2);
    expect(records.filter(({ type, subtype }) => type === "result" && subtype === "success").map(({ result }) => result)).toEqual(["first", "second"]);
    expect(transport.requests[1]?.messages.some((message) =>
      message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text === "first")
    )).toBe(true);
  });

  test("executes SDK control requests and returns correlated payloads", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    let stdout = "";
    async function* input() {
      yield JSON.stringify({ type: "control_request", request_id: "mcp-add", request: {
        subtype: "mcp_add", name: "fixture", server: { command: "node", args: ["server.js"] },
      } });
      yield JSON.stringify({ type: "control_request", request_id: "mcp-disable", request: {
        subtype: "mcp_disable", name: "fixture",
      } });
      yield JSON.stringify({ type: "control_request", request_id: "task-create", request: {
        subtype: "task_create", subject: "Review", description: "Review the SDK controls",
      } });
      yield JSON.stringify({ type: "control_request", request_id: "task-list", request: { subtype: "task_list" } });
      yield JSON.stringify({ type: "control_request", request_id: "plugins", request: { subtype: "plugin_reload" } });
      yield JSON.stringify({ type: "user", prompt: "finish" });
    }
    const transport = new ScriptedTransport([
      [{ type: "text", index: 0, text: "done" }, { type: "response-end", reason: "end-turn" }],
    ]);

    expect(await runStreamJsonCli({
      argv: ["-p", "--input-format", "stream-json", "--output-format", "stream-json"],
      env: {}, cwd, configDir,
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: () => undefined },
      transport,
      input: input(),
      sessionIdFactory: () => "sdk-control-session",
    })).toBe(0);

    const controls = stdout.trim().split("\n").map((line) => JSON.parse(line))
      .filter(({ type }) => type === "control_response");
    expect(controls.map(({ request_id }) => request_id)).toEqual([
      "mcp-add", "mcp-disable", "task-create", "task-list", "plugins",
    ]);
    expect(controls.every(({ response }) => response.subtype === "success")).toBe(true);
    expect(controls[1]?.response.payload).toEqual({ name: "fixture", enabled: false });
    expect(controls[3]?.response.payload).toEqual([expect.objectContaining({ subject: "Review" })]);
    expect(JSON.parse(await readFile(join(configDir, "mcp.json"), "utf8"))).toMatchObject({
      mcpServers: { fixture: { command: "node", enabled: false } },
    });
  });

  test("forks a stream-json session once before processing multiple records", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const source = new SessionStore({ configDir, cwd, sessionId: "stream-source" });
    await source.append([{ role: "user", content: [{ type: "text", text: "source context" }] }]);
    const transport = new ScriptedTransport([
      [{ type: "text", index: 0, text: "first" }, { type: "response-end", reason: "end-turn" }],
      [{ type: "text", index: 0, text: "second" }, { type: "response-end", reason: "end-turn" }],
    ]);
    async function* input() {
      yield JSON.stringify({ type: "user", prompt: "one" });
      yield JSON.stringify({ type: "user", prompt: "two" });
    }

    expect(await runStreamJsonCli({
      argv: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--resume", "stream-source", "--fork-session", "--session-id", "stream-target"],
      env: {},
      cwd,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
      input: input(),
    })).toBe(0);

    const target = await new SessionStore({ configDir, cwd, sessionId: "stream-target" }).readState();
    expect(target.parentSessionId).toBe("stream-source");
    expect(target.messages.filter((message) => message.role === "user")).toHaveLength(3);
    expect((await source.read()).filter((message) => message.role === "user")).toHaveLength(1);
  });

  test("returns a structured error for malformed stream-json input", async () => {
    async function* input() { yield "not-json"; }
    let stdout = "";
    expect(await runStreamJsonCli({
      argv: ["-p", "--input-format", "stream-json", "--output-format", "stream-json"],
      env: {},
      cwd: await workspace(),
      configDir: await workspace(),
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: () => undefined },
      transport: new ScriptedTransport([]),
      input: input(),
    })).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ type: "result", subtype: "error", error: "Invalid stream-json input" });
  });

  test("returns one structured result in JSON output mode", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "structured result" },
      { type: "response-end", reason: "end-turn" },
    ]]);
    let stdout = "";

    expect(await runCli({
      argv: ["-p", "inspect", "--output-format", "json"],
      env: {},
      cwd,
      configDir,
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: () => undefined },
      transport,
      sessionIdFactory: () => "json-session",
    })).toBe(0);

    expect(JSON.parse(stdout)).toEqual({
      type: "result",
      subtype: "success",
      session_id: "json-session",
      stop_reason: "end-turn",
      result: "structured result",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 0,
      },
      total_usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 0,
      },
      total_cost_usd: 0,
    });
  });

  test("requires and returns schema-validated structured output", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: { answer: { type: "string" } },
    };
    const transport = new ScriptedTransport([
      [
        { type: "tool-start", index: 0, id: "structured-1", name: "structured_output" },
        { type: "tool-input", index: 0, json: JSON.stringify({ answer: "done" }) },
        { type: "response-end", reason: "tool-use" },
      ],
      [{ type: "response-end", reason: "end-turn" }],
    ]);
    let stdout = "";

    expect(await runCli({
      argv: ["-p", "answer", "--output-format", "json", "--json-schema", JSON.stringify(schema)],
      env: {},
      cwd,
      configDir,
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: () => undefined },
      transport,
      sessionIdFactory: () => "structured-output-session",
    })).toBe(0);

    expect(transport.requests[0]?.tools.at(-1)).toMatchObject({
      name: "structured_output",
      inputSchema: schema,
    });
    expect(JSON.parse(stdout).structured_output).toEqual({ answer: "done" });
  });

  test("stops when streamed usage exceeds the invocation budget", async () => {
    const transport = new ScriptedTransport([[
      {
        type: "usage",
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      { type: "response-end", reason: "end-turn" },
    ]]);
    let stderr = "";

    expect(await runCli({
      argv: ["-p", "expensive", "--max-budget-usd", "0.01"],
      env: {},
      cwd: await workspace(),
      configDir: await workspace(),
      stdout: { write: () => undefined },
      stderr: { write: (text) => { stderr += text; } },
      transport,
    })).toBe(1);
    expect(stderr).toContain("Maximum budget of $0.01 exceeded");
  });

  test("attaches repeated workspace text and image files to the initial prompt", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    await writeFile(join(cwd, "notes.txt"), "important context\n");
    await writeFile(
      join(cwd, "pixel.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
    );
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "attachments received" },
      { type: "response-end", reason: "end-turn" },
    ]]);

    expect(await runCli({
      argv: ["-p", "inspect these files", "--attachment", "notes.txt", "-a", "pixel.png"],
      env: {},
      cwd,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
      sessionIdFactory: () => "attachment-session",
    })).toBe(0);

    const user = transport.requests[0]?.messages.find((message) => message.role === "user");
    expect(user?.content.some((block) => block.type === "text" && block.text === "inspect these files")).toBe(true);
    expect(user?.content.some((block) => block.type === "text" && block.text.includes("important context"))).toBe(true);
    expect(user?.content.some((block) => block.type === "image" && block.source.mediaType === "image/png")).toBe(true);
  });

  test("rejects attachments outside the workspace before calling the model", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const outside = join(await workspace(), "secret.txt");
    await writeFile(outside, "secret");
    const transport = new ScriptedTransport([]);
    let stderr = "";
    expect(await runCli({
      argv: ["-p", "inspect", "--attachment", outside],
      env: {},
      cwd,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: (text) => { stderr += text; } },
      transport,
    })).toBe(1);
    expect(stderr).toContain("outside the workspace");
    expect(transport.requests).toHaveLength(0);
  });

  test("starts a session in a named managed worktree and persists it for resume", async () => {
    const cwd = await gitWorkspace();
    const configDir = await workspace();
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "worktree ready" },
      { type: "response-end", reason: "end-turn" },
    ]]);

    expect(await runCli({
      argv: ["-p", "inspect", "--worktree", "--branch", "feature/start"],
      env: {},
      cwd,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
      sessionIdFactory: () => "worktree-start-session",
    })).toBe(0);

    const state = await new SessionStore({ configDir, cwd, sessionId: "worktree-start-session" }).readState();
    expect(state.worktree).toMatchObject({
      worktreeName: "feature/start",
      worktreeBranch: "tnb-worktree-feature+start",
    });
    expect((await listManagedWorktreeJobs(cwd))[0]).toMatchObject({
      id: "feature+start",
      changedFiles: 0,
      uniqueCommits: 0,
    });
    expect(transport.requests[0]?.systemPrompt).toContain(state.worktree?.worktreePath ?? "missing");
  });

  test("emits model, tool, and terminal JSON Lines in stream-json mode", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const transport = new ScriptedTransport(toolTurn("read", { path: "package.json" }));
    await writeFile(join(cwd, "package.json"), "{}\n");
    let stdout = "";

    expect(await runCli({
      argv: ["-p", "inspect", "--output-format", "stream-json"],
      env: {},
      cwd,
      configDir,
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: () => undefined },
      transport,
      sessionIdFactory: () => "stream-session",
    })).toBe(0);

    const records = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.some(({ type }) => type === "model_event")).toBe(true);
    expect(records.some(({ type }) => type === "tool_event")).toBe(true);
    expect(records.at(-1)).toMatchObject({
      type: "result",
      subtype: "success",
      session_id: "stream-session",
      result: "Done",
    });
  });

  test("runs session lifecycle hooks once and injects startup context", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const endMarker = join(configDir, "session-ended");
    const startupOutput = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "startup-context",
      },
    });
    await writeFile(join(configDir, "settings.json"), JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: "startup",
          hooks: [{ type: "command", command: `printf '%s' '${startupOutput}'` }],
        }],
        SessionEnd: [{
          matcher: "prompt_input_exit",
          hooks: [{ type: "command", command: `printf ended > '${endMarker}'` }],
        }],
      },
    }));
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "Done" },
      { type: "response-end", reason: "end-turn" },
    ]]);

    expect(await runCli({
      argv: ["-p", "inspect", "--model", "test"],
      env: {},
      cwd,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);

    const firstPrompt = transport.requests[0]?.messages[0]?.content[0];
    expect(firstPrompt?.type === "text" ? firstPrompt.text : "").toContain("startup-context");
    expect(await readFile(endMarker, "utf8")).toBe("ended");
  });

  test("reports the exact project instruction file through InstructionsLoaded", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const hookLog = join(configDir, "instructions-loaded.json");
    const instructionPath = join(cwd, "AGENTS.md");
    await writeFile(instructionPath, "Use the project conventions.\n");
    await writeFile(join(configDir, "settings.json"), JSON.stringify({
      hooks: {
        InstructionsLoaded: [{
          matcher: "Project",
          hooks: [{ type: "command", command: `cat > '${hookLog}'` }],
        }],
      },
    }));

    expect(await runCli({
      argv: ["-p", "inspect"],
      env: {},
      cwd,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport: new ScriptedTransport([[
        { type: "text", index: 0, text: "Done" },
        { type: "response-end", reason: "end-turn" },
      ]]),
    })).toBe(0);

    expect(JSON.parse(await readFile(hookLog, "utf8"))).toMatchObject({
      hook_event_name: "InstructionsLoaded",
      file_path: instructionPath,
      memory_type: "Project",
      load_reason: "session_start",
    });
  });

  test("runs Setup and SessionStart hooks without initializing a provider in init-only mode", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const log = join(configDir, "setup.log");
    await writeFile(join(configDir, "settings.json"), JSON.stringify({
      hooks: {
        Setup: [{ matcher: "init", hooks: [{ type: "command", command: `printf 'setup\n' >> '${log}'` }] }],
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `printf 'session\n' >> '${log}'` }] }],
      },
    }));

    expect(await runCli({
      argv: ["-p", "unused", "--init-only"],
      env: {},
      cwd,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    })).toBe(0);
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["setup", "session"]);
  });

  test("optionally includes hook records and partial model deltas in stream-json", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    await writeFile(join(configDir, "settings.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "printf ready" }] }],
      },
    }));
    const response: ModelEvent[] = [
      { type: "text", index: 0, text: "partial" },
      { type: "response-end", reason: "end-turn" },
    ];
    let defaultOutput = "";
    await runCli({
      argv: ["-p", "inspect", "--output-format", "stream-json"],
      env: {}, cwd, configDir,
      stdout: { write: (text) => { defaultOutput += text; } },
      stderr: { write: () => undefined },
      transport: new ScriptedTransport([response]),
    });
    expect(defaultOutput).not.toContain('"type":"text"');

    let verboseOutput = "";
    await runCli({
      argv: ["-p", "inspect", "--output-format", "stream-json", "--include-hook-events", "--include-partial-messages"],
      env: {}, cwd, configDir,
      stdout: { write: (text) => { verboseOutput += text; } },
      stderr: { write: () => undefined },
      transport: new ScriptedTransport([response]),
      sessionIdFactory: () => "verbose-stream-session",
    });
    const records = verboseOutput.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.some(({ subtype }) => subtype === "hook_started")).toBe(true);
    expect(records.some(({ subtype }) => subtype === "hook_response")).toBe(true);
    expect(records.some(({ type, event }) => type === "model_event" && event.type === "text")).toBe(true);
  });

  test("fires StopFailure hooks for terminal provider errors", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const log = join(configDir, "stop-failure.json");
    await writeFile(join(configDir, "settings.json"), JSON.stringify({
      hooks: {
        StopFailure: [{ matcher: "authentication_failed", hooks: [{ type: "command", command: `cat > '${log}'` }] }],
      },
    }));
    const transport: ModelTransport = {
      async *stream() {
        throw new ProviderHttpError(401, "invalid credential", new Headers());
      },
    };

    expect(await runCli({
      argv: ["-p", "inspect"], env: {}, cwd, configDir,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(1);
    expect(JSON.parse(await readFile(log, "utf8"))).toMatchObject({
      hook_event_name: "StopFailure",
      error: "authentication_failed",
      error_details: "invalid credential",
    });
  });

  test("lists configured providers and models as JSON without starting an Agent turn", async () => {
    const configDir = await workspace();
    await writeFile(
      join(configDir, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:11434/v1",
            models: [
              { id: "coder-small", contextWindow: 32_000, maxTokens: 4_096 },
              { id: "coder-large", contextWindow: 128_000, maxTokens: 16_384, reasoning: true },
            ],
          },
        },
      }),
    );
    let stdout = "";

    expect(await runModelsCli({
      argv: ["models", "--json"],
      env: {},
      configDir,
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: () => undefined },
    })).toBe(0);

    expect(JSON.parse(stdout)).toContainEqual({
      provider: "local",
      providerName: "local",
      api: "openai-completions",
      model: "coder-small",
      modelName: "coder-small",
      contextWindow: 32_000,
      maxTokens: 4_096,
      reasoning: false,
      default: true,
    });
  });

  test("selects a configured provider id and its default model", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    await writeFile(
      join(configDir, "models.json"),
      JSON.stringify({
        providers: {
          deepseek: {
            api: "openai-completions",
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "$DEEPSEEK_API_KEY",
            models: [
              { id: "deepseek-chat", contextWindow: 64_000, maxTokens: 8_192 },
            ],
          },
        },
      }),
    );
    const transport = new ScriptedTransport([
      [
        { type: "text", index: 0, text: "configured" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);

    expect(
      await runCli({
        argv: ["-p", "hello", "--provider", "deepseek"],
        env: { DEEPSEEK_API_KEY: "secret" },
        cwd,
        configDir,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport,
      }),
    ).toBe(0);
    expect(transport.requests[0]?.model).toBe("deepseek-chat");
    expect(transport.requests[0]?.systemPrompt).toContain("- Model: deepseek-chat");
  });

  test("uses the provider and model selected in settings when flags are absent", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    await writeFile(join(configDir, "models.json"), JSON.stringify({
      providers: {
        local: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:11434/v1",
          models: [{ id: "settings-model", contextWindow: 32_000, maxTokens: 4_096 }],
        },
      },
    }));
    await writeFile(join(configDir, "settings.json"), JSON.stringify({
      provider: "local",
      model: "settings-model",
    }));
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "configured" },
      { type: "response-end", reason: "end-turn" },
    ]]);

    expect(await runCli({
      argv: ["-p", "hello"],
      env: {},
      cwd,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);
    expect(transport.requests[0]?.model).toBe("settings-model");
  });

  test("applies a highest-priority temporary settings JSON", async () => {
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "configured" },
      { type: "response-end", reason: "end-turn" },
    ]]);
    expect(await runCli({
      argv: ["-p", "inspect", "--settings", '{"model":"temporary-model"}'],
      env: {},
      cwd: await workspace(),
      configDir: await workspace(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);
    expect(transport.requests[0]?.model).toBe("temporary-model");
  });

  test("adds CLI-defined agents to the Agent tool schema", async () => {
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "configured" },
      { type: "response-end", reason: "end-turn" },
    ]]);
    const agents = JSON.stringify({
      reviewer: { description: "Reviews a change", prompt: "Review carefully.", tools: ["read", "grep"] },
    });
    expect(await runCli({
      argv: ["-p", "inspect", "--model", "test", "--agents", agents],
      env: {},
      cwd: await workspace(),
      configDir: await workspace(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);
    const agent = transport.requests[0]?.tools.find((tool) => tool.name === "agent");
    expect(agent?.description).toContain("reviewer: Reviews a change");
    expect((agent?.inputSchema.properties as Record<string, { enum?: string[] }>).subagent_type?.enum).toContain("reviewer");
  });

  test("applies a CLI-defined Agent profile to the main thread", async () => {
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "reviewed" },
      { type: "response-end", reason: "end-turn" },
    ]]);
    const agents = JSON.stringify({
      reviewer: {
        description: "Reviews a change",
        prompt: "Review carefully and report only verified findings.",
        tools: ["read", "grep"],
        model: "review-model",
        permissionMode: "plan",
        maxTurns: 3,
      },
    });
    expect(await runCli({
      argv: ["-p", "inspect", "--agents", agents, "--agent", "reviewer"],
      env: {},
      cwd: await workspace(),
      configDir: await workspace(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);

    expect(transport.requests[0]?.model).toBe("review-model");
    expect(transport.requests[0]?.systemPrompt).toContain("Review carefully and report only verified findings.");
    expect(transport.requests[0]?.tools.map(({ name }) => name)).toEqual(["read", "grep"]);
  });

  test("lets explicit CLI options override main-thread Agent profile defaults", async () => {
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "done" },
      { type: "response-end", reason: "end-turn" },
    ]]);
    const agents = JSON.stringify({
      reviewer: {
        description: "Reviews a change",
        prompt: "Profile prompt",
        tools: ["read"],
        model: "profile-model",
      },
    });
    expect(await runCli({
      argv: [
        "-p", "inspect", "--agents", agents, "--agent", "reviewer",
        "--model", "explicit-model", "--system-prompt", "Explicit prompt", "--tools", "grep",
      ],
      env: {},
      cwd: await workspace(),
      configDir: await workspace(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);

    expect(transport.requests[0]?.model).toBe("explicit-model");
    expect(transport.requests[0]?.systemPrompt).toContain("Explicit prompt");
    expect(transport.requests[0]?.systemPrompt).not.toContain("Profile prompt");
    expect(transport.requests[0]?.tools.map(({ name }) => name)).toEqual(["grep"]);
  });

  test("calls a configured OpenAI-compatible endpoint without an injected transport", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    let receivedUrl: URL | undefined;
    let receivedHeaders: Headers | undefined;
    let receivedBody: Record<string, unknown> | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        receivedUrl = new URL(request.url);
        receivedHeaders = request.headers;
        receivedBody = await request.json() as Record<string, unknown>;
        return new Response(
          [
            `data: ${JSON.stringify({ choices: [{ delta: { content: "local provider" }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    await writeFile(
      join(configDir, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            api: "openai-completions",
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            apiKey: "$LOCAL_MODEL_KEY",
            headers: { "x-workspace": "$LOCAL_WORKSPACE" },
            compat: {
              maxTokensField: "max_tokens",
              supportsReasoningEffort: true,
            },
            models: [
              {
                id: "local-coder",
                contextWindow: 32_000,
                maxTokens: 4_096,
                reasoning: true,
                headers: { "x-model-route": "$LOCAL_MODEL_ROUTE" },
              },
            ],
          },
        },
      }),
    );
    let stdout = "";

    try {
      expect(
        await runCli({
          argv: ["-p", "hello", "--provider", "local", "--thinking", "high"],
          env: {
            LOCAL_MODEL_KEY: "secret",
            LOCAL_WORKSPACE: "tnb",
            LOCAL_MODEL_ROUTE: "fast",
          },
          cwd,
          configDir,
          stdout: { write: (value) => { stdout += value; } },
          stderr: { write: () => undefined },
        }),
      ).toBe(0);
    } finally {
      server.stop(true);
    }

    expect(receivedUrl?.pathname).toBe("/v1/chat/completions");
    expect(receivedHeaders?.get("authorization")).toBe("Bearer secret");
    expect(receivedHeaders?.get("x-workspace")).toBe("tnb");
    expect(receivedHeaders?.get("x-model-route")).toBe("fast");
    expect(receivedBody?.model).toBe("local-coder");
    expect(receivedBody?.max_tokens).toBe(4_096);
    expect(receivedBody?.reasoning_effort).toBe("high");
    expect(stdout).toContain("local provider");
  });

  test("calls a configured OpenAI Responses endpoint through the Agent loop", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    await writeFile(join(cwd, "note.txt"), "hello responses");
    let receivedUrl: URL | undefined;
    const receivedBodies: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        receivedUrl = new URL(request.url);
        receivedBodies.push(await request.json() as Record<string, unknown>);
        const events = receivedBodies.length === 1
          ? [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "reasoning", id: "rs-1", summary: [], encrypted_content: null },
              },
              {
                type: "response.reasoning_summary_text.delta",
                output_index: 0,
                delta: "Read the requested file",
              },
              {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "reasoning",
                  id: "rs-1",
                  encrypted_content: "encrypted-reasoning",
                  summary: [{ type: "summary_text", text: "Read the requested file" }],
                },
              },
              {
                type: "response.output_item.added",
                output_index: 1,
                item: {
                  type: "function_call",
                  id: "fc-1",
                  call_id: "call-1",
                  name: "read",
                  arguments: "",
                },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: 1,
                delta: '{"path":"note.txt"}',
              },
              {
                type: "response.completed",
                response: { id: "resp-1", status: "completed", output: [] },
              },
            ]
          : [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id: "msg-1", role: "assistant", content: [], status: "in_progress" },
              },
              {
                type: "response.output_text.delta",
                output_index: 0,
                delta: "responses provider",
              },
              {
                type: "response.completed",
                response: { id: "resp-2", status: "completed", output: [] },
              },
            ];
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    await writeFile(
      join(configDir, "models.json"),
      JSON.stringify({
        providers: {
          responses: {
            api: "openai-responses",
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            models: [
              { id: "gpt-5-compatible", contextWindow: 128_000, maxTokens: 16_384 },
            ],
          },
        },
      }),
    );
    let stdout = "";

    try {
      expect(await runCli({
        argv: ["-p", "hello", "--provider", "responses"],
        env: {},
        cwd,
        configDir,
        stdout: { write: (value) => { stdout += value; } },
        stderr: { write: () => undefined },
        sessionIdFactory: () => "responses-session",
      })).toBe(0);
    } finally {
      server.stop(true);
    }

    expect(receivedUrl?.pathname).toBe("/v1/responses");
    expect(receivedBodies[0]).toMatchObject({
      model: "gpt-5-compatible",
      stream: true,
      store: false,
    });
    expect(receivedBodies[1]?.input).toContainEqual({
      type: "reasoning",
      id: "rs-1",
      encrypted_content: "encrypted-reasoning",
      summary: [{ type: "summary_text", text: "Read the requested file" }],
    });
    expect(receivedBodies[1]?.input).toContainEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "hello responses",
    });
    const persisted = await new SessionStore({
      configDir,
      cwd,
      sessionId: "responses-session",
    }).read();
    expect(persisted[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Read the requested file",
          signature: JSON.stringify({
            type: "reasoning",
            id: "rs-1",
            encrypted_content: "encrypted-reasoning",
            summary: [{ type: "summary_text", text: "Read the requested file" }],
          }),
        },
        { type: "tool-use", id: "call-1", name: "read", input: { path: "note.txt" } },
      ],
    });
    expect(stdout).toContain("responses provider");
  });

  test("sends the migrated system prompt and project instructions to the provider", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "AGENTS.md"), "Always run the focused test first.");
    const transport = new ScriptedTransport([
      [
        { type: "text", index: 0, text: "ready" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);

    expect(
      await runCli({
        argv: ["-p", "inspect", "--model", "test"],
        env: {},
        cwd,
        configDir: await workspace(),
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport,
      }),
    ).toBe(0);

    const prompt = transport.requests[0]?.systemPrompt ?? "";
    expect(prompt).toContain("# Doing tasks");
    expect(prompt).toContain("# Using your tools");
    expect(prompt).toContain(cwd);
    expect(prompt).toContain("Always run the focused test first.");
    expect(prompt).not.toContain("You are a local coding agent.");
  });

  test("loads replacement and appended system prompts from files", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "system.txt"), "Replacement prompt");
    await writeFile(join(cwd, "append.txt"), "Appended prompt");
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "ready" },
      { type: "response-end", reason: "end-turn" },
    ]]);

    expect(await runCli({
      argv: ["-p", "inspect", "--model", "test", "--system-prompt-file", "system.txt", "--append-system-prompt-file", "append.txt"],
      env: {},
      cwd,
      configDir: await workspace(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);
    expect(transport.requests[0]?.systemPrompt).toContain("Replacement prompt");
    expect(transport.requests[0]?.systemPrompt).toContain("Appended prompt");
    expect(transport.requests[0]?.systemPrompt).not.toContain("# Doing tasks");
  });

  test("selects the provider-facing tool set with --tools", async () => {
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "ready" },
      { type: "response-end", reason: "end-turn" },
    ]]);
    expect(await runCli({
      argv: ["-p", "inspect", "--model", "test", "--tools", "read,grep"],
      env: {},
      cwd: await workspace(),
      configDir: await workspace(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);
    expect(transport.requests[0]?.tools.map((tool) => tool.name)).toEqual(["read", "grep"]);
  });

  test("supports an explicitly empty --tools selection", async () => {
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "ready" },
      { type: "response-end", reason: "end-turn" },
    ]]);
    expect(await runCli({
      argv: ["-p", "inspect", "--model", "test", "--tools", ""],
      env: {},
      cwd: await workspace(),
      configDir: await workspace(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);
    expect(transport.requests[0]?.tools).toEqual([]);
  });

  test("adds explicit workspace roots to tool access and the system prompt", async () => {
    const cwd = await workspace();
    const additional = await workspace();
    await writeFile(join(additional, "shared.txt"), "shared root");
    const transport = new ScriptedTransport(toolTurn("read", { path: join(additional, "shared.txt") }));

    expect(await runCli({
      argv: ["-p", "inspect shared", "--model", "test", "--add-dir", additional],
      env: {},
      cwd,
      configDir: await workspace(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);

    expect(transport.requests[0]?.systemPrompt).toContain(additional);
    expect(transport.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: [{
        type: "tool-result",
        toolUseId: "call-1",
        content: "shared root",
        isError: false,
      }],
    });
  });
  test("forwards model and tool lifecycle events without terminal output for the TUI", async () => {
    const cwd = await workspace();
    const modelEvents: ModelEvent[] = [];
    const toolEvents: unknown[] = [];
    let stdout = "";
    const transport = new ScriptedTransport(
      toolTurn("read", { path: "package.json" }),
    );

    expect(
      await runCli({
        argv: ["-p", "inspect", "--model", "test"],
        env: {},
        cwd,
        configDir: await workspace(),
        stdout: { write: (text) => void (stdout += text) },
        stderr: { write: () => undefined },
        transport,
        quiet: true,
        onEvent: (event) => modelEvents.push(event),
        onToolEvent: (event) => toolEvents.push(event),
      }),
    ).toBe(0);

    expect(stdout).toBe("");
    expect(modelEvents.some((event) => event.type === "text")).toBe(true);
    expect(toolEvents.map((event) => (event as { type: string }).type)).toEqual([
      "tool-execution-start",
      "tool-execution-end",
    ]);
  });
  test("streams text and exposes the built-in tools", async () => {
    const transport = new ScriptedTransport([
      [
        { type: "text", index: 0, text: "Hello world" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);
    let stdout = "";

    const exitCode = await runCli({
      argv: ["-p", "Say hello", "--model", "test-model"],
      env: {},
      cwd: process.cwd(),
      configDir: await workspace(),
      stdout: { write: (text) => void (stdout += text) },
      stderr: { write: () => undefined },
      transport,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toBe("Hello world\n");
    expect(transport.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "edit",
      "notebook_edit",
      "bash",
      "bash_output",
      "bash_input",
      "bash_resize",
      "bash_kill",
      "grep",
      "glob",
      "codebase_investigator",
      "web_fetch",
      "todo_write",
      "ask_user_question",
      "task_create",
      "task_get",
      "task_update",
      "task_list",
      "task_output",
      "task_stop",
      "goal_get",
      "goal_create",
      "goal_update",
      ...(Bun.which("typescript-language-server") || Bun.which("pyright-langserver") || Bun.which("gopls") || Bun.which("rust-analyzer") || Bun.which("clangd")
        ? ["lsp"]
        : []),
      "update_topic",
      "enter_worktree",
      "exit_worktree",
      "checkpoint_create",
      "checkpoint_list",
      "checkpoint_rollback",
      "send_message",
      "complete_task",
      "agent",
      "workflow",
      "enter_plan_mode",
      "exit_plan_mode",
      "skill",
    ]);
  });

  test("continues an active goal until completion and persists its turn usage", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const transport = new ScriptedTransport([
      [
        { type: "tool-start", index: 0, id: "goal-create", name: "goal_create" },
        { type: "tool-input", index: 0, json: '{"objective":"Finish the task","max_turns":2}' },
        { type: "response-end", reason: "tool-use" },
      ],
      [
        { type: "text", index: 0, text: "Working" },
        { type: "response-end", reason: "end-turn" },
      ],
      [
        { type: "tool-start", index: 0, id: "goal-complete", name: "goal_update" },
        { type: "tool-input", index: 0, json: '{"status":"complete"}' },
        { type: "response-end", reason: "tool-use" },
      ],
      [
        { type: "text", index: 0, text: "Done" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);
    let stdout = "";

    expect(await runCli({
      argv: ["-p", "Start a goal", "--yolo"],
      env: {},
      cwd,
      configDir,
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: () => undefined },
      transport,
      sessionIdFactory: () => "goal-session",
    })).toBe(0);

    expect(stdout).toBe("WorkingDone\n");
    expect(transport.requests).toHaveLength(4);
    expect(JSON.stringify(transport.requests[2]?.messages)).toContain("Continue working toward the active session goal");
    expect(JSON.parse(await readFile(join(configDir, "goals", "goal-session.json"), "utf8"))).toMatchObject({
      objective: "Finish the task",
      status: "complete",
      turnsUsed: 2,
      maxTurns: 2,
    });
  });

  test("enforces read-only plan mode and restores the preceding mode after approval", async () => {
    const cwd = await workspace();
    const transport = new ScriptedTransport([
      [
        { type: "tool-start", index: 0, id: "enter", name: "enter_plan_mode" },
        { type: "tool-input", index: 0, json: "{}" },
        { type: "response-end", reason: "tool-use" },
      ],
      [
        { type: "tool-start", index: 0, id: "blocked-write", name: "write" },
        {
          type: "tool-input",
          index: 0,
          json: JSON.stringify({ path: "blocked.txt", content: "blocked" }),
        },
        { type: "response-end", reason: "tool-use" },
      ],
      [
        { type: "tool-start", index: 0, id: "exit", name: "exit_plan_mode" },
        {
          type: "tool-input",
          index: 0,
          json: JSON.stringify({ plan: "1. Inspect.\n2. Implement.\n3. Test." }),
        },
        { type: "response-end", reason: "tool-use" },
      ],
      [
        { type: "tool-start", index: 0, id: "allowed-write", name: "write" },
        {
          type: "tool-input",
          index: 0,
          json: JSON.stringify({ path: "allowed.txt", content: "implemented" }),
        },
        { type: "response-end", reason: "tool-use" },
      ],
      [
        { type: "text", index: 0, text: "Implemented." },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);
    const modeChanges: string[] = [];
    const approvals: string[] = [];

    expect(
      await runCli({
        argv: ["-p", "plan and implement", "--model", "test", "--permission-mode", "acceptEdits"],
        env: {},
        cwd,
        configDir: await workspace(),
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport,
        permissionPrompt: async (request) => {
          approvals.push(request.tool.name);
          return "allow";
        },
        onPermissionModeChange: (mode) => modeChanges.push(mode),
      }),
    ).toBe(0);

    expect(await Bun.file(join(cwd, "blocked.txt")).exists()).toBe(false);
    expect(await readFile(join(cwd, "allowed.txt"), "utf8")).toBe("implemented");
    expect(modeChanges).toEqual(["plan", "acceptEdits"]);
    expect(approvals).toEqual(["exit_plan_mode"]);
  });

  test("runs an explore subagent with an isolated message history and discovery tools", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const hookLog = join(configDir, "subagent-hooks.log");
    await writeFile(join(configDir, "settings.json"), JSON.stringify({
      hooks: {
        SubagentStart: [{
          matcher: "explore",
          hooks: [{ type: "command", command: `printf start >> '${hookLog}'` }],
        }],
        SubagentStop: [{
          matcher: "explore",
          hooks: [{ type: "command", command: `printf stop >> '${hookLog}'` }],
        }],
      },
    }));
    const transport = new ScriptedTransport([
      [
        { type: "tool-start", index: 0, id: "agent-call", name: "agent" },
        {
          type: "tool-input",
          index: 0,
          json: JSON.stringify({
            description: "Locate provider code",
            prompt: "Find the provider registry and report the relevant files.",
            subagent_type: "explore",
            model: "test-small",
          }),
        },
        { type: "response-end", reason: "tool-use" },
      ],
      [
        { type: "text", index: 0, text: "The registry is in src/providers." },
        { type: "response-end", reason: "end-turn" },
      ],
      [
        { type: "text", index: 0, text: "Located." },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);

    expect(
      await runCli({
        argv: ["-p", "locate provider", "--model", "test", "--yolo"],
        env: {},
        cwd,
        configDir,
        sessionIdFactory: () => "main-session",
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport,
      }),
    ).toBe(0);

    expect(transport.requests[1]?.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Find the provider registry and report the relevant files.",
          },
        ],
      },
    ]);
    expect(transport.requests[1]?.model).toBe("test-small");
    expect(transport.requests[1]?.systemPrompt).toContain("- Model: test-small");
    expect(transport.requests[1]?.tools.map(({ name }) => name)).toEqual([
      "read",
      "grep",
      "glob",
      "web_fetch",
    ]);
    expect(transport.requests[2]?.messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool-result",
          toolUseId: "agent-call",
          content: "The registry is in src/providers.",
          isError: false,
        },
      ],
    });
    expect(await readFile(hookLog, "utf8")).toBe("startstop");
    const parentSession = new SessionStore({ configDir, cwd, sessionId: "main-session" });
    const transcriptDirectory = join(parentSession.projectDir, "main-session", "subagents");
    const transcripts = await readdir(transcriptDirectory);
    expect(transcripts).toHaveLength(1);
    expect(await readFile(join(transcriptDirectory, transcripts[0]!), "utf8")).toContain(
      "Find the provider registry",
    );
  });

  test("returns interactive question answers to the model", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const responseNotification = join(configDir, "elicitation-response.json");
    await writeFile(join(configDir, "settings.json"), JSON.stringify({
      hooks: {
        Notification: [{
          matcher: "elicitation_response",
          hooks: [{ type: "command", command: `cat > '${responseNotification}'` }],
        }],
      },
    }));
    const transport = new ScriptedTransport(
      toolTurn("ask_user_question", {
        questions: [
          {
            header: "Library",
            question: "Which library should we use?",
            options: [
              { label: "Existing", description: "Use the current dependency" },
              { label: "Custom", description: "Build a local implementation" },
            ],
          },
        ],
      }),
    );
    const asked: string[] = [];

    expect(
      await runCli({
        argv: ["-p", "choose", "--model", "test"],
        env: {},
        cwd,
        configDir,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport,
        async askUser(question) {
          asked.push(question.question);
          return "Existing";
        },
      }),
    ).toBe(0);

    expect(asked).toEqual(["Which library should we use?"]);
    expect(JSON.parse(await readFile(responseNotification, "utf8"))).toMatchObject({
      hook_event_name: "Notification",
      notification_type: "elicitation_response",
      message: "Question response: accept",
      title: "Elicitation response",
    });
    expect(transport.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool-result",
          toolUseId: "call-1",
          content: expect.stringContaining('"Which library should we use?"="Existing"'),
          isError: false,
        },
      ],
    });
  });

  test("exposes WebSearch when the official search API key is configured", async () => {
    const transport = new ScriptedTransport([
      [
        { type: "text", index: 0, text: "Ready" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);

    expect(
      await runCli({
        argv: ["-p", "search", "--model", "test"],
        env: { BRAVE_SEARCH_API_KEY: "search-key" },
        cwd: process.cwd(),
        configDir: await workspace(),
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport,
      }),
    ).toBe(0);
    expect(transport.requests[0]?.tools.map((tool) => tool.name)).toContain("web_search");
  });

  test("reports missing Anthropic credentials before making a request", async () => {
    let stderr = "";
    const exitCode = await runCli({
      argv: ["-p", "hello"],
      env: {},
      cwd: process.cwd(),
      configDir: await workspace(),
      stdout: { write: () => undefined },
      stderr: { write: (text) => void (stderr += text) },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ANTHROPIC_API_KEY is required");
  });

  test("rejects an invalid compaction threshold", async () => {
    let stderr = "";
    const transport = new ScriptedTransport([]);
    const exitCode = await runCli({
      argv: ["-p", "hello", "--model", "test"],
      env: { TNB_COMPACT_THRESHOLD_TOKENS: "0" },
      cwd: process.cwd(),
      configDir: await workspace(),
      stdout: { write: () => undefined },
      stderr: { write: (text) => void (stderr += text) },
      transport,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("TNB_COMPACT_THRESHOLD_TOKENS must be a positive integer");
    expect(transport.requests).toHaveLength(0);
  });

  test("rejects an unsupported reasoning effort before making a request", async () => {
    let stderr = "";
    const transport = new ScriptedTransport([]);
    const exitCode = await runCli({
      argv: ["-p", "hello", "--thinking", "extreme"],
      env: {},
      cwd: process.cwd(),
      configDir: await workspace(),
      stdout: { write: () => undefined },
      stderr: { write: (text) => void (stderr += text) },
      transport,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--thinking must be one of: off, minimal, low, medium, high, xhigh");
    expect(transport.requests).toHaveLength(0);
  });

  test("default permission mode blocks writes", async () => {
    const cwd = await workspace();
    const transport = new ScriptedTransport(toolTurn("write", { path: "created.txt", content: "hello" }));
    const exitCode = await runCli({
      argv: ["-p", "create", "--model", "test"],
      env: {},
      cwd,
      configDir: await workspace(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    });
    expect(exitCode).toBe(0);
    expect(await Bun.file(join(cwd, "created.txt")).exists()).toBe(false);
  });

  test("lets PermissionRequest hooks approve and rewrite validated tool input", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const hookOutput = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: { path: "approved.txt", content: "from hook" },
        },
      },
    });
    await writeFile(join(configDir, "settings.json"), JSON.stringify({
      hooks: {
        PermissionRequest: [{
          matcher: "write",
          hooks: [{ type: "command", command: `printf '%s' '${hookOutput}'` }],
        }],
      },
    }));
    const transport = new ScriptedTransport(toolTurn("write", {
      path: "original.txt",
      content: "original",
    }));

    expect(await runCli({
      argv: ["-p", "write a file", "--model", "test"],
      env: {},
      cwd,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);
    expect(await readFile(join(cwd, "approved.txt"), "utf8")).toBe("from hook");
    expect(await Bun.file(join(cwd, "original.txt")).exists()).toBe(false);
  });

  test("interactive mode prompts for an ask decision and keeps one session", async () => {
    const cwd = await workspace();
    const answers = ["create a file", "y", "/exit"];
    let stdout = "";
    const transport = new ScriptedTransport(
      toolTurn("write", { path: "interactive.txt", content: "approved" }),
    );

    expect(
      await runInteractiveCli({
        argv: ["--model", "test"],
        env: {},
        cwd,
        configDir: await workspace(),
        stdout: { write: (text) => void (stdout += text) },
        stderr: { write: () => undefined },
        transport,
        question: async () => answers.shift() ?? "/exit",
        sessionIdFactory: () => "interactive-session",
      }),
    ).toBe(0);
    expect(await readFile(join(cwd, "interactive.txt"), "utf8")).toBe("approved");
    expect(stdout).toContain("Permission required");
  });

  test("interactive mode expands MCP prompt slash commands over a persistent connection", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const serverPath = join(await workspace(), "prompt-mcp.ts");
    await writeFile(
      serverPath,
      [
        'import { createInterface } from "node:readline";',
        'const lines = createInterface({ input: process.stdin });',
        'lines.on("line", (line) => {',
        '  const message = JSON.parse(line);',
        '  if (!("id" in message)) return;',
        '  let result;',
        '  if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { prompts: {} } };',
        '  if (message.method === "prompts/list") result = { prompts: [{ name: "review", arguments: [{ name: "target", required: true }] }] };',
        '  if (message.method === "prompts/get") result = { messages: [{ role: "user", content: { type: "text", text: `Review ${message.params.arguments.target}` } }] };',
        '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");',
        '});',
      ].join("\n"),
    );
    await writeFile(
      join(configDir, "mcp.json"),
      JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [serverPath] } } }),
    );
    const answers = ["/mcp__fixture__review src", "/exit"];
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "reviewed" },
      { type: "response-end", reason: "end-turn" },
    ]]);

    expect(await runInteractiveCli({
      argv: ["--model", "test"],
      env: {},
      cwd,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
      question: async () => answers.shift() ?? "/exit",
      sessionIdFactory: () => "mcp-prompt-session",
    })).toBe(0);
    expect(transport.requests[0]?.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Review src" }],
    });
  });

  test("bypass mode allows write, edit, and bash", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "notes.txt"), "before\n");
    const transports = [
      new ScriptedTransport(toolTurn("write", { path: "created.txt", content: "hello" })),
      new ScriptedTransport(toolTurn("edit", { path: "notes.txt", oldText: "before", newText: "after" })),
      new ScriptedTransport(toolTurn("bash", { command: "printf ran > ran.txt" })),
    ];
    for (const transport of transports) {
      expect(
        await runCli({
          argv: ["-p", "act", "--model", "test", "--permission-mode", "bypass"],
          env: {},
          cwd,
          configDir: await workspace(),
          stdout: { write: () => undefined },
          stderr: { write: () => undefined },
          transport,
        }),
      ).toBe(0);
    }
    expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("hello");
    expect(await readFile(join(cwd, "notes.txt"), "utf8")).toBe("after\n");
    expect(await readFile(join(cwd, "ran.txt"), "utf8")).toBe("ran");
  });

  test("runs notebook cell edits through the Agent loop and workspace write policy", async () => {
    const cwd = await workspace();
    const path = join(cwd, "analysis.ipynb");
    await writeFile(
      path,
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            id: "calculation",
            source: "value = 1",
            metadata: {},
            execution_count: 1,
            outputs: [{ output_type: "execute_result" }],
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
    );
    const transport = new ScriptedTransport(
      toolTurn("notebook_edit", {
        notebook_path: "analysis.ipynb",
        cell_id: "calculation",
        new_source: "value = 2",
      }),
    );

    expect(
      await runCli({
        argv: ["-p", "update calculation", "--model", "test", "--permission-mode", "acceptEdits"],
        env: {},
        cwd,
        configDir: await workspace(),
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport,
      }),
    ).toBe(0);

    const updated = JSON.parse(await readFile(path, "utf8")) as {
      cells: Array<Record<string, unknown>>;
    };
    expect(updated.cells[0]).toMatchObject({
      id: "calculation",
      source: "value = 2",
      execution_count: null,
      outputs: [],
    });
    expect(transport.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool-result",
          toolUseId: "call-1",
          content: "Updated cell calculation in analysis.ipynb",
          isError: false,
        },
      ],
    });
  });

  test("accepts explicit YOLO mode as the bypassPermissions user alias", async () => {
    const cwd = await workspace();
    const transport = new ScriptedTransport(
      toolTurn("write", { path: "yolo.txt", content: "enabled" }),
    );

    expect(
      await runCli({
        argv: ["-p", "act", "--model", "test", "--permission-mode", "yolo"],
        env: {},
        cwd,
        configDir: await workspace(),
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport,
      }),
    ).toBe(0);
    expect(await readFile(join(cwd, "yolo.txt"), "utf8")).toBe("enabled");
  });

  test("accepts the Claude-compatible dangerous permission alias", async () => {
    const cwd = await workspace();
    const transport = new ScriptedTransport(
      toolTurn("write", { path: "dangerous-alias.txt", content: "enabled" }),
    );

    expect(await runCli({
      argv: ["-p", "act", "--model", "test", "--dangerously-skip-permissions"],
      env: {},
      cwd,
      configDir: await workspace(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);
    expect(await readFile(join(cwd, "dangerous-alias.txt"), "utf8")).toBe("enabled");
  });

  test("uses configured auto mode for safe filesystem bash commands", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    await writeFile(
      join(configDir, "settings.json"),
      JSON.stringify({
        permissions: { defaultMode: "auto" },
      }),
    );

    const transport = new ScriptedTransport(
      toolTurn("bash", { command: "touch generated-output.txt" }),
    );
    expect(
      await runCli({
        argv: ["-p", "prepare", "--model", "test"],
        env: {},
        cwd,
        configDir,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport,
      }),
    ).toBe(0);
    expect(await Bun.file(join(cwd, "generated-output.txt")).exists()).toBe(true);
  });

  test("applies configured rules and blocks YOLO when security settings disable it", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    await writeFile(
      join(configDir, "settings.json"),
      JSON.stringify({
        permissions: { allow: ["write(allowed.txt)"] },
        security: { disableYolo: true },
      }),
    );

    const allowed = new ScriptedTransport(
      toolTurn("write", { path: "allowed.txt", content: "allowed" }),
    );
    expect(
      await runCli({
        argv: ["-p", "write", "--model", "test"],
        env: {},
        cwd,
        configDir,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport: allowed,
      }),
    ).toBe(0);
    expect(await readFile(join(cwd, "allowed.txt"), "utf8")).toBe("allowed");

    const blocked = new ScriptedTransport(
      toolTurn("write", { path: "blocked.txt", content: "blocked" }),
    );
    let stderr = "";
    expect(
      await runCli({
        argv: ["-p", "write", "--model", "test", "--yolo"],
        env: {},
        cwd,
        configDir,
        stdout: { write: () => undefined },
        stderr: { write: (text) => void (stderr += text) },
        transport: blocked,
      }),
    ).toBe(0);
    expect(await Bun.file(join(cwd, "blocked.txt")).exists()).toBe(false);
    expect(stderr).toContain("YOLO mode is disabled by settings; using default mode");
  });

  test("file tools remain workspace-confined in bypass mode", async () => {
    const cwd = await workspace();
    const outside = join(cwd, "..", `outside-${crypto.randomUUID()}.txt`);
    const transport = new ScriptedTransport(toolTurn("write", { path: outside, content: "escape" }));
    const exitCode = await runCli({
      argv: ["-p", "escape", "--model", "test", "--permission-mode", "bypass"],
      env: {},
      cwd,
      configDir: await workspace(),
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    });
    expect(exitCode).toBe(0);
    expect(await Bun.file(outside).exists()).toBe(false);
  });

  test("persists a session and resumes its message history", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const first = new ScriptedTransport([
      [
        { type: "text", index: 0, text: "remembered" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);
    expect(
      await runCli({
        argv: ["-p", "first", "--model", "test"],
        env: {},
        cwd,
        configDir,
        sessionIdFactory: () => "session-fixed",
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport: first,
      }),
    ).toBe(0);

    const resumed = new ScriptedTransport([
      [
        { type: "text", index: 0, text: "continued" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);
    expect(
      await runCli({
        argv: ["-p", "second", "--model", "test", "--resume", "session-fixed"],
        env: {},
        cwd,
        configDir,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport: resumed,
      }),
    ).toBe(0);

    expect(resumed.requests[0]?.messages.slice(0, 3)).toEqual([
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "remembered" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]);
  });

  test("uses an explicit session id only for a new session", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "created" },
      { type: "response-end", reason: "end-turn" },
    ]]);

    expect(await runCli({
      argv: ["-p", "new", "--model", "test", "--session-id", "explicit-session"],
      env: {},
      cwd,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);
    expect((await new SessionStore({ configDir, cwd, sessionId: "explicit-session" }).read())[0]).toMatchObject({ role: "user" });

    let stderr = "";
    expect(await runCli({
      argv: ["-p", "duplicate", "--model", "test", "--session-id", "explicit-session"],
      env: {},
      cwd,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: (text) => void (stderr += text) },
      transport: new ScriptedTransport([]),
    })).toBe(1);
    expect(stderr).toContain("already in use");
  });

  test("forks a resumed session to a named explicit session", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const source = new SessionStore({ configDir, cwd, sessionId: "fork-source" });
    await source.append([
      { role: "user", content: [{ type: "text", text: "original" }] },
      { role: "assistant", content: [{ type: "text", text: "history" }] },
    ]);
    const transport = new ScriptedTransport([[
      { type: "text", index: 0, text: "forked" },
      { type: "response-end", reason: "end-turn" },
    ]]);

    expect(await runCli({
      argv: ["-p", "continue fork", "--model", "test", "--resume", "fork-source", "--fork-session", "--session-id", "fork-target", "--name", "Review branch"],
      env: {},
      cwd,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);

    const target = await new SessionStore({ configDir, cwd, sessionId: "fork-target" }).readState();
    expect(target.parentSessionId).toBe("fork-source");
    expect(target.title).toBe("Review branch");
    expect(target.messages.slice(0, 3)).toEqual([
      { role: "user", content: [{ type: "text", text: "original" }] },
      { role: "assistant", content: [{ type: "text", text: "history" }] },
      { role: "user", content: [{ type: "text", text: "continue fork" }] },
    ]);
    expect((await source.read()).map((message) => message.content[0])).toEqual([
      { type: "text", text: "original" },
      { type: "text", text: "history" },
    ]);
  });

  test("persists model-updated session topic metadata", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const transport = new ScriptedTransport(toolTurn("update_topic", {
      title: "Provider migration",
      summary: "Move the Agent to a configurable provider.",
      strategic_intent: "Keep the core protocol-neutral.",
    }));

    expect(await runCli({
      argv: ["-p", "continue the migration", "--model", "test"],
      env: {},
      cwd,
      configDir,
      sessionIdFactory: () => "topic-session",
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);

    expect(await new SessionStore({ configDir, cwd, sessionId: "topic-session" }).readState()).toMatchObject({
      title: "Provider migration",
      summary: "Move the Agent to a configurable provider.",
      strategicIntent: "Keep the core protocol-neutral.",
    });
  });

  test("restores todo state from session history before the next replacement", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const first = new ScriptedTransport(
      toolTurn("todo_write", {
        todos: [
          { content: "Inspect", activeForm: "Inspecting", status: "in_progress" },
        ],
      }),
    );
    expect(
      await runCli({
        argv: ["-p", "start", "--model", "test"],
        env: {},
        cwd,
        configDir,
        sessionIdFactory: () => "todo-session",
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport: first,
      }),
    ).toBe(0);

    const second = new ScriptedTransport(
      toolTurn("todo_write", {
        todos: [{ content: "Test", activeForm: "Testing", status: "in_progress" }],
      }),
    );
    expect(
      await runCli({
        argv: ["-p", "continue", "--model", "test", "--resume", "todo-session"],
        env: {},
        cwd,
        configDir,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport: second,
      }),
    ).toBe(0);
    const result = second.requests[1]?.messages.at(-1);
    const content = result?.content[0];
    expect(content?.type).toBe("tool-result");
    if (content?.type !== "tool-result") throw new Error("Expected todo tool result");
    expect(content.content).toContain('"content":"Inspect"');
    expect(content.content).toContain('"content":"Test"');
  });

  test("continues the latest session in the current workspace", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    await runCli({
      argv: ["-p", "first", "--model", "test"],
      env: {},
      cwd,
      configDir,
      sessionIdFactory: () => "latest-session",
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport: new ScriptedTransport([
        [
          { type: "text", index: 0, text: "stored" },
          { type: "response-end", reason: "end-turn" },
        ],
      ]),
    });
    const continued = new ScriptedTransport([
      [
        { type: "text", index: 0, text: "continued" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);

    expect(
      await runCli({
        argv: ["-p", "second", "--model", "test", "--continue"],
        env: {},
        cwd,
        configDir,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport: continued,
      }),
    ).toBe(0);
    expect(continued.requests[0]?.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "first" }],
    });
  });

  test("compacts a resumed session and persists the replacement boundary", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const session = new SessionStore({ configDir, cwd, sessionId: "compact-session" });
    const history: ConversationMessage[] = [
      { role: "user", content: [{ type: "text", text: "question one" }] },
      { role: "assistant", content: [{ type: "text", text: "answer one" }] },
      { role: "user", content: [{ type: "text", text: "question two" }] },
      { role: "assistant", content: [{ type: "text", text: "answer two" }] },
      { role: "user", content: [{ type: "text", text: "recent question" }] },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
    ];
    await session.append(history);
    const transport = new ScriptedTransport([
      [
        { type: "text", index: 0, text: "Earlier work summary" },
        { type: "response-end", reason: "end-turn" },
      ],
      [
        { type: "text", index: 0, text: "continued" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);

    expect(
      await runCli({
        argv: ["-p", "continue now", "--model", "test", "--resume", "compact-session"],
        env: { TNB_COMPACT_THRESHOLD_TOKENS: "1" },
        cwd,
        configDir,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport,
      }),
    ).toBe(0);

    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[0]?.tools).toEqual([]);
    expect(transport.requests[1]?.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Conversation summary:\n\nEarlier work summary" }],
    });
    expect(await Bun.file(session.filePath).text()).toContain('"type":"compact_boundary"');
    expect((await session.read())[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Conversation summary:\n\nEarlier work summary" }],
    });
  });

  test("discovers and calls a configured stdio MCP tool", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const serverPath = join(await workspace(), "fixture-mcp.ts");
    await writeFile(
      serverPath,
      [
        'import { createInterface } from "node:readline";',
        'const lines = createInterface({ input: process.stdin });',
        'lines.on("line", (line) => {',
        '  const message = JSON.parse(line);',
        '  if (!("id" in message)) return;',
        '  let result;',
        '  if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {}, logging: {} }, serverInfo: { name: "fixture", version: "1" } };',
        '  if (message.method === "logging/setLevel") result = {};',
        '  if (message.method === "tools/list") result = { tools: [{ name: "echo.value", description: "Echo a value", inputSchema: { type: "object" } }] };',
        '  if (message.method === "tools/call") result = { content: [{ type: "text", text: `echo:${message.params.arguments.value}` }], isError: false };',
        '  if (message.method === "tools/call") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: message.params._meta.progressToken, progress: 1, total: 2, message: "Echoing" } }) + "\\n");',
        '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");',
        '  if (message.method === "tools/call") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/elicitation/complete", params: { elicitationId: "checkout-42" } }) + "\\n");',
        '  if (message.method === "tools/call") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "warning", logger: "fixture", data: { message: "attention" } } }) + "\\n");',
        '  if (message.method === "tools/call") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: message.id, reason: "Late cancellation" } }) + "\\n");',
        '});',
      ].join("\n"),
    );
    await writeFile(
      join(configDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          fixture: { command: process.execPath, args: [serverPath] },
        },
      }),
    );
    const transport = new ScriptedTransport(toolTurn("mcp__fixture__echo_value", { value: "hello" }));
    let stdout = "";

    const exitCode = await runCli({
      argv: ["-p", "use fixture", "--model", "test", "--permission-mode", "bypass", "--output-format", "stream-json"],
      env: {},
      cwd,
      configDir,
      stdout: { write: (text) => { stdout += text; } },
      stderr: { write: () => undefined },
      transport,
    });

    expect(exitCode).toBe(0);
    expect(transport.requests[0]?.tools.map((tool) => tool.name)).toContain(
      "mcp__fixture__echo_value",
    );
    expect(stdout.trim().split("\n").map((line) => JSON.parse(line))).toContainEqual({
      type: "system",
      subtype: "elicitation_complete",
      mcp_server_name: "fixture",
      elicitation_id: "checkout-42",
      uuid: expect.any(String),
      session_id: expect.any(String),
    });
    expect(stdout.trim().split("\n").map((line) => JSON.parse(line))).toContainEqual({
      type: "system",
      subtype: "mcp_log",
      mcp_server_name: "fixture",
      level: "warning",
      logger: "fixture",
      data: { message: "attention" },
      uuid: expect.any(String),
      session_id: expect.any(String),
    });
    expect(stdout.trim().split("\n").map((line) => JSON.parse(line))).toContainEqual({
      type: "system",
      subtype: "mcp_progress",
      mcp_server_name: "fixture",
      progress_token: "tnb-1",
      progress: 1,
      total: 2,
      message: "Echoing",
      uuid: expect.any(String),
      session_id: expect.any(String),
    });
    expect(stdout.trim().split("\n").map((line) => JSON.parse(line))).toContainEqual({
      type: "system",
      subtype: "mcp_cancelled",
      mcp_server_name: "fixture",
      request_id: expect.any(Number),
      reason: "Late cancellation",
      uuid: expect.any(String),
      session_id: expect.any(String),
    });
    expect(transport.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool-result",
          toolUseId: "call-1",
          content: "echo:hello",
          isError: false,
        },
      ],
    });
  });

  test("loads only explicit MCP servers in strict CLI config mode", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const serverPath = join(await workspace(), "strict-mcp.ts");
    await writeFile(serverPath, [
      'import { createInterface } from "node:readline";',
      'createInterface({ input: process.stdin }).on("line", (line) => {',
      '  const message = JSON.parse(line); if (!("id" in message)) return;',
      '  const result = message.method === "initialize"',
      '    ? { protocolVersion: "2025-11-25", capabilities: { tools: {} } }',
      '    : message.method === "tools/list"',
      '      ? { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] }',
      '      : { content: [{ type: "text", text: "strict" }] };',
      '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");',
      '});',
    ].join("\n"));
    await writeFile(join(configDir, "mcp.json"), JSON.stringify({
      mcpServers: { ignored: { command: "missing-command" } },
    }));
    const explicit = JSON.stringify({
      mcpServers: { explicit: { command: process.execPath, args: [serverPath] } },
    });
    const transport = new ScriptedTransport(toolTurn("mcp__explicit__echo", {}));

    expect(await runCli({
      argv: ["-p", "use explicit", "--model", "test", "--permission-mode", "bypass", "--mcp-config", explicit, "--strict-mcp-config"],
      env: {},
      cwd,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      transport,
    })).toBe(0);
    expect(transport.requests[0]?.tools.map((tool) => tool.name)).toContain("mcp__explicit__echo");
  });

  test("discovers and calls a configured Streamable HTTP MCP tool", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const headers: Array<{ session: string | null; protocol: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        if (request.method === "GET") return new Response(null, { status: 405 });
        const message = (await request.json()) as {
          id?: number;
          method: string;
          params?: { arguments?: { value?: string } };
        };
        headers.push({
          session: request.headers.get("mcp-session-id"),
          protocol: request.headers.get("mcp-protocol-version"),
        });
        if (!("id" in message)) return new Response(null, { status: 202 });
        let result: unknown;
        if (message.method === "initialize") {
          result = {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "remote", version: "1" },
          };
        } else if (message.method === "tools/list") {
          result = {
            tools: [
              { name: "echo.remote", description: "Echo", inputSchema: { type: "object" } },
            ],
          };
        } else {
          result = {
            content: [
              { type: "text", text: `remote:${message.params?.arguments?.value}` },
            ],
            isError: false,
          };
        }
        return Response.json(
          { jsonrpc: "2.0", id: message.id, result },
          message.method === "initialize"
            ? { headers: { "MCP-Session-Id": "remote-session" } }
            : undefined,
        );
      },
    });
    try {
      await writeFile(
        join(configDir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            remote: { type: "http", url: `${server.url}mcp` },
          },
        }),
      );
      const transport = new ScriptedTransport(
        toolTurn("mcp__remote__echo_remote", { value: "hello" }),
      );

      expect(
        await runCli({
          argv: ["-p", "use remote", "--model", "test", "--permission-mode", "bypass"],
          env: {},
          cwd,
          configDir,
          stdout: { write: () => undefined },
          stderr: { write: () => undefined },
          transport,
        }),
      ).toBe(0);

      expect(transport.requests[0]?.tools.map((tool) => tool.name)).toContain(
        "mcp__remote__echo_remote",
      );
      expect(transport.requests[1]?.messages.at(-1)).toEqual({
        role: "user",
        content: [
          {
            type: "tool-result",
            toolUseId: "call-1",
            content: "remote:hello",
            isError: false,
          },
        ],
      });
      expect(headers[0]).toEqual({ session: null, protocol: null });
      expect(headers[1]).toEqual({
        session: "remote-session",
        protocol: "2025-11-25",
      });
    } finally {
      server.stop(true);
    }
  });

  test("runs a configured skill in an isolated Agent loop", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const skillDir = join(configDir, "skills", "review");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: review",
        "description: Review a requested path",
        "allowed-tools: [read]",
        "---",
        "Inspect $ARGUMENTS and report findings.",
      ].join("\n"),
    );
    const transport = new ScriptedTransport([
      [
        { type: "tool-start", index: 0, id: "skill-call", name: "skill" },
        {
          type: "tool-input",
          index: 0,
          json: '{"name":"review","arguments":"src/main.ts"}',
        },
        { type: "response-end", reason: "tool-use" },
      ],
      [
        { type: "text", index: 0, text: "review complete" },
        { type: "response-end", reason: "end-turn" },
      ],
      [
        { type: "text", index: 0, text: "done" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);

    expect(
      await runCli({
        argv: ["-p", "review src", "--model", "test", "--permission-mode", "bypass"],
        env: {},
        cwd,
        configDir,
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        transport,
      }),
    ).toBe(0);

    expect(transport.requests[0]?.tools.map((tool) => tool.name)).toContain("skill");
    expect(transport.requests[1]?.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(transport.requests[1]?.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: expect.stringContaining("Inspect src/main.ts and report findings."),
        },
      ],
    });
    expect(transport.requests[2]?.messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool-result",
          toolUseId: "skill-call",
          content: "review complete",
          isError: false,
        },
      ],
    });
  });

  test("lets a skill-local PermissionRequest hook authorize its nested tool", async () => {
    const cwd = await workspace();
    const configDir = await workspace();
    const skillDirectory = join(configDir, "skills", "writer");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(configDir, "settings.json"), JSON.stringify({
      permissions: { allow: ["skill"] },
    }));
    const hookOutput = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      [
        "---",
        "name: writer",
        "description: Write a requested file",
        "allowed-tools: [write]",
        "hooks:",
        "  PermissionRequest:",
        "    - matcher: write",
        "      hooks:",
        "        - type: command",
        `          command: printf '%s' '${hookOutput}'`,
        "---",
        "Write the requested file.",
      ].join("\n"),
    );
    const transport = new ScriptedTransport([
      [
        { type: "tool-start", index: 0, id: "skill-call", name: "skill" },
        { type: "tool-input", index: 0, json: '{"name":"writer","arguments":"approved.txt"}' },
        { type: "response-end", reason: "tool-use" },
      ],
      ...toolTurn("write", { path: "approved.txt", content: "approved by skill hook" }),
      [
        { type: "text", index: 0, text: "skill finished" },
        { type: "response-end", reason: "end-turn" },
      ],
    ]);
    let stderr = "";

    expect(await runCli({
      argv: ["-p", "run writer", "--model", "test"],
      env: {},
      cwd,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: (text) => void (stderr += text) },
      transport,
    })).toBe(0);
    expect(stderr).toBe("");
    expect(await readFile(join(cwd, "approved.txt"), "utf8")).toBe("approved by skill hook");
  });
});

async function gitWorkspace(): Promise<string> {
  const root = await workspace();
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(stderr);
  };
  await git(["init", "-q"]);
  await git(["config", "user.email", "tnb@example.invalid"]);
  await git(["config", "user.name", "tnb test"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "base"]);
  return root;
}
