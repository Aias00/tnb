import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HookRunner } from "../../src/services/hooks/runner";

describe("command hooks", () => {
  test("matches tool names and accepts structured permission output", async () => {
    const payload = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { file_path: "changed.txt" },
        additionalContext: "checked",
      },
    });
    const runner = new HookRunner({
      cwd: process.cwd(),
      sessionId: "test-session",
      env: process.env,
      hooks: {
        PreToolUse: [{
          matcher: "Write|Edit",
          hooks: [{ type: "command", command: `printf '%s' '${payload}'` }],
        }],
      },
    });

    const result = await runner.run("PreToolUse", {
      tool_name: "Write",
      tool_input: { file_path: "old.txt" },
      tool_use_id: "1",
    });

    expect(result.permissionDecision).toBe("allow");
    expect(result.updatedInput).toEqual({ file_path: "changed.txt" });
    expect(result.context).toEqual(["checked"]);
  });

  test("treats exit code 2 as a blocking hook result", async () => {
    const runner = new HookRunner({
      cwd: process.cwd(),
      sessionId: "test-session",
      env: process.env,
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: "printf 'blocked by policy' >&2; exit 2" }],
        }],
      },
    });

    const result = await runner.run("PreToolUse", { tool_name: "Bash" });
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("blocked by policy");
  });

  test("parses PermissionRequest decision objects", async () => {
    const payload = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: { file_path: "approved.txt" },
        },
      },
    });
    const runner = new HookRunner({
      cwd: process.cwd(),
      sessionId: "permission-session",
      env: process.env,
      hooks: {
        PermissionRequest: [{
          matcher: "Write",
          hooks: [{ type: "command", command: `printf '%s' '${payload}'` }],
        }],
      },
    });

    const result = await runner.run("PermissionRequest", {
      tool_name: "Write",
      tool_input: { file_path: "original.txt" },
    });
    expect(result.permissionDecision).toBe("allow");
    expect(result.updatedInput).toEqual({ file_path: "approved.txt" });
  });

  test("matches MCP elicitation server names and parses hook responses", async () => {
    const payload = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "Elicitation",
        action: "accept",
        content: { approved: true },
      },
    });
    const runner = new HookRunner({
      cwd: process.cwd(),
      sessionId: "elicitation-session",
      env: process.env,
      hooks: {
        Elicitation: [{
          matcher: "profile-server",
          hooks: [{ type: "command", command: `printf '%s' '${payload}'` }],
        }],
      },
    });

    const result = await runner.run("Elicitation", {
      mcp_server_name: "profile-server",
      message: "Provide profile data",
      mode: "form",
    });
    expect(result.elicitationResponse).toEqual({
      action: "accept",
      content: { approved: true },
    });
  });

  test("runs session lifecycle once while allowing compact lifecycle refreshes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tnb-hooks-"));
    const log = join(directory, "events.log");
    const runner = new HookRunner({
      cwd: directory,
      sessionId: "session-lifecycle",
      env: process.env,
      hooks: {
        SessionStart: [{
          matcher: "startup|compact",
          hooks: [{ type: "command", command: `printf '%s\\n' start >> '${log}'` }],
        }],
        SessionEnd: [{
          matcher: "prompt_input_exit",
          hooks: [{ type: "command", command: `printf '%s\\n' end >> '${log}'` }],
        }],
      },
    });

    await runner.start("startup", "test-model");
    await runner.start("startup", "test-model");
    await runner.start("compact", "test-model");
    await runner.end("prompt_input_exit");
    await runner.end("prompt_input_exit");

    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["start", "start", "end"]);
  });

  test("executes later hooks from an updated session cwd", async () => {
    const initial = await mkdtemp(join(tmpdir(), "tnb-hooks-old-"));
    const next = await mkdtemp(join(tmpdir(), "tnb-hooks-new-"));
    const log = join(initial, "cwd.log");
    const runner = new HookRunner({
      cwd: initial,
      sessionId: "cwd-session",
      env: process.env,
      hooks: {
        CwdChanged: [{ hooks: [{ type: "command", command: `pwd > '${log}'` }] }],
      },
    });

    runner.setCwd(next);
    await runner.run("CwdChanged", { old_cwd: initial, new_cwd: next });
    expect((await readFile(log, "utf8")).trim()).toBe(await realpath(next));
  });

  test("observes exact FileChanged matcher paths and emits command lifecycle events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tnb-hooks-files-"));
    const log = join(directory, "file-event.json");
    const events: string[] = [];
    const runner = new HookRunner({
      cwd: directory,
      sessionId: "file-session",
      env: process.env,
      hooks: {
        FileChanged: [{
          matcher: "watched.txt",
          hooks: [{ type: "command", command: `cat > '${log}'` }],
        }],
      },
    });
    runner.setObserver((event) => events.push(event.type));
    await runner.start("startup");
    await writeFile(join(directory, "watched.txt"), "changed\n");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await readFile(log, "utf8").catch(() => "")) break;
      await Bun.sleep(25);
    }
    await runner.end("prompt_input_exit");

    const input = JSON.parse(await readFile(log, "utf8"));
    expect(input).toMatchObject({ hook_event_name: "FileChanged", event: "add" });
    expect(input.file_path).toBe(join(directory, "watched.txt"));
    expect(events).toContain("started");
    expect(events).toContain("response");
  });

  test("audits settings files changed by an external process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tnb-hooks-config-"));
    const settings = join(directory, "settings.json");
    const log = join(directory, "config-event.json");
    await writeFile(settings, "{}\n");
    const runner = new HookRunner({
      cwd: directory,
      sessionId: "config-session",
      env: process.env,
      configFiles: [{ path: settings, source: "user_settings" }],
      hooks: {
        ConfigChange: [{
          matcher: "user_settings",
          hooks: [{ type: "command", command: `cat > '${log}'` }],
        }],
      },
    });
    await runner.start("startup");
    await writeFile(settings, '{"model":"changed"}\n');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await readFile(log, "utf8").catch(() => "")) break;
      await Bun.sleep(25);
    }
    await runner.end("prompt_input_exit");

    expect(JSON.parse(await readFile(log, "utf8"))).toMatchObject({
      hook_event_name: "ConfigChange",
      source: "user_settings",
      file_path: settings,
    });
  });
});
