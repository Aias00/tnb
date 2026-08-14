import { describe, expect, test } from "bun:test";

import {
  createPermissionChecker,
  evaluatePermission,
  parsePermissionRule,
  resolvePermissionMode,
} from "../../src/core/permissions";

function tool(name: string, risk: "read" | "write" | "execute" | "network" | "unknown") {
  return {
    name,
    risk,
    isReadOnly: () => risk === "read",
    permissionRuleContent(input: unknown) {
      if (typeof input !== "object" || input === null) return undefined;
      const value = input as Record<string, unknown>;
      return typeof value.command === "string"
        ? value.command
        : typeof value.path === "string"
          ? value.path
          : undefined;
    },
  };
}

describe("permission checker", () => {
  test("default mode allows reads and denies mutations in non-interactive use", async () => {
    const check = createPermissionChecker({ mode: "default" });

    expect(await check(tool("Read", "read"), {})).toEqual({ behavior: "allow" });
    expect(await check(tool("Write", "write"), {})).toEqual({
      behavior: "deny",
      message: "Write requires approval, but prompting is unavailable in non-interactive mode",
    });
  });

  test("default mode allows read-only bash commands when the tool marks them read-only", async () => {
    const check = createPermissionChecker({ mode: "default" });
    const bash = {
      ...tool("bash", "execute"),
      isReadOnly: (input: unknown) => {
        const value = input as { command?: string };
        return value.command === "pwd";
      },
    };

    expect(await check(bash, { command: "pwd" })).toEqual({ behavior: "allow" });
    expect(await check(bash, { command: "touch notes.txt" })).toEqual({
      behavior: "deny",
      message: "bash requires approval, but prompting is unavailable in non-interactive mode",
    });
  });

  test("resolves ask decisions through an interactive approval callback", async () => {
    const requests: string[] = [];
    const check = createPermissionChecker({
      mode: "default",
      async onAsk({ tool, message }) {
        requests.push(`${tool.name}:${message}`);
        return "allow";
      },
    });

    expect(await check(tool("Write", "write"), { path: "notes.txt" })).toEqual({
      behavior: "allow",
    });
    expect(requests).toEqual(["Write:Write requires approval"]);
  });

  test("remembers an exact allow decision for the current checker session", async () => {
    const requests: string[] = [];
    const check = createPermissionChecker({
      mode: "default",
      async onAsk(request) {
        requests.push(request.suggestedRule ?? "missing");
        return "allow-session";
      },
    });
    const bash = tool("Bash", "execute");

    expect(await check(bash, { command: "bun test" })).toEqual({ behavior: "allow" });
    expect(await check(bash, { command: "bun test" })).toEqual({ behavior: "allow" });
    expect(await check(bash, { command: "bun run typecheck" })).toEqual({ behavior: "allow" });
    expect(requests).toEqual(["Bash(bun test)", "Bash(bun run typecheck)"]);
  });

  test("shares session grants across per-turn checker instances", async () => {
    const sessionAllowRules: string[] = [];
    let prompts = 0;
    const options = {
      mode: "default" as const,
      sessionAllowRules,
      async onAsk() {
        prompts += 1;
        return "allow-session" as const;
      },
    };
    const bash = tool("Bash", "execute");

    expect(await createPermissionChecker(options)(bash, { command: "bun test" })).toEqual({ behavior: "allow" });
    expect(await createPermissionChecker(options)(bash, { command: "bun test" })).toEqual({ behavior: "allow" });
    expect(prompts).toBe(1);
  });

  test("persists an exact project grant through an injected settings service", async () => {
    const persisted: string[] = [];
    const check = createPermissionChecker({
      mode: "default",
      async onAsk() {
        return "allow-project";
      },
      async persistPermissionRule(rule) {
        persisted.push(rule);
      },
    });

    expect(await check(tool("Write", "write"), { path: "notes.txt" })).toEqual({ behavior: "allow" });
    expect(persisted).toEqual(["Write(notes.txt)"]);
  });

  test("does not offer session grants for mandatory approval tools", async () => {
    let suggestedRule: string | undefined;
    const mandatory = {
      ...tool("exit_plan_mode", "read"),
      requiresApproval: () => true,
    };
    const check = createPermissionChecker({
      mode: "default",
      async onAsk(request) {
        suggestedRule = request.suggestedRule;
        return "allow-session";
      },
    });

    expect(await check(mandatory, { plan: "Do the work" })).toEqual({
      behavior: "deny",
      message: "User denied permission to use exit_plan_mode",
    });
    expect(suggestedRule).toBeUndefined();
  });

  test("lets a PermissionRequest hook decide and update input before prompting", async () => {
    let prompted = false;
    const check = createPermissionChecker({
      mode: "default",
      async onPermissionRequest({ tool, input }) {
        expect(tool.name).toBe("Write");
        expect(input).toEqual({ path: "old.txt" });
        return { behavior: "allow", updatedInput: { path: "new.txt" } };
      },
      async onAsk() {
        prompted = true;
        return "deny";
      },
    });

    expect(await check(tool("Write", "write"), { path: "old.txt" })).toEqual({
      behavior: "allow",
      updatedInput: { path: "new.txt" },
    });
    expect(prompted).toBe(false);
  });

  test("plan mode only allows read-risk tools", async () => {
    const check = createPermissionChecker({ mode: "plan" });

    expect(await check(tool("Bash", "execute"), {})).toEqual({
      behavior: "deny",
      message: "Bash is unavailable in plan mode",
    });
  });

  test("network tools require bypass permission", async () => {
    const webFetch = tool("web_fetch", "network");

    expect(await createPermissionChecker({ mode: "default" })(webFetch, {})).toEqual({
      behavior: "deny",
      message: "web_fetch requires approval, but prompting is unavailable in non-interactive mode",
    });
    expect(await createPermissionChecker({ mode: "bypassPermissions" })(webFetch, {})).toEqual({
      behavior: "allow",
    });
  });

  test("YOLO mode allows mutations unless administratively disabled", async () => {
    const write = tool("Write", "write");

    expect(
      await createPermissionChecker({ mode: "bypassPermissions" })(write, {}),
    ).toEqual({ behavior: "allow" });
    expect(
      await createPermissionChecker({ mode: "bypassPermissions", disableYolo: true })(
        write,
        {},
      ),
    ).toEqual({
      behavior: "deny",
      message: "Write requires approval, but prompting is unavailable in non-interactive mode",
    });
  });

  test("parses tool-wide and content permission rules with escaped parentheses", () => {
    expect(parsePermissionRule("Bash")).toEqual({ toolName: "Bash" });
    expect(parsePermissionRule("Bash(*)")).toEqual({ toolName: "Bash" });
    expect(parsePermissionRule(String.raw`Bash(node -e "console.log\(1\)")`)).toEqual({
      toolName: "Bash",
      ruleContent: 'node -e "console.log(1)"',
    });
  });

  test("applies deny then ask before YOLO and allow rules", () => {
    const bash = tool("Bash", "execute");
    const rules = {
      allow: ["Bash(npm test:*)"],
      ask: ["Bash(npm test --watch)"],
      deny: ["Bash(npm test --watch --unsafe)"],
    };

    expect(
      evaluatePermission(
        { mode: "bypassPermissions", rules },
        bash,
        { command: "npm test --watch --unsafe" },
      ).behavior,
    ).toBe("deny");
    expect(
      evaluatePermission(
        { mode: "bypassPermissions", rules },
        bash,
        { command: "npm test --watch" },
      ).behavior,
    ).toBe("ask");
    expect(
      evaluatePermission(
        { mode: "default", rules },
        bash,
        { command: "npm test unit" },
      ).behavior,
    ).toBe("allow");
  });

  test("supports MCP server-wide rules without matching similarly named built-ins", () => {
    const rules = { allow: ["mcp__files__*"] };
    expect(
      evaluatePermission(
        { mode: "default", rules },
        tool("mcp__files__read", "unknown"),
        {},
      ).behavior,
    ).toBe("allow");
    expect(
      evaluatePermission({ mode: "default", rules }, tool("read", "read"), {}).behavior,
    ).toBe("allow");
    expect(
      evaluatePermission({ mode: "default", rules }, tool("write", "write"), {}).behavior,
    ).toBe("ask");
  });

  test("implements acceptEdits and dontAsk modes", () => {
    expect(
      evaluatePermission({ mode: "acceptEdits" }, tool("write", "write"), {}).behavior,
    ).toBe("allow");
    expect(
      evaluatePermission({ mode: "acceptEdits" }, tool("bash", "execute"), {}).behavior,
    ).toBe("ask");
    expect(
      evaluatePermission({ mode: "dontAsk" }, tool("bash", "execute"), {}).behavior,
    ).toBe("deny");
  });

  test("auto mode allows safe workspace edits but still gates broader execution", () => {
    expect(
      evaluatePermission(
        { mode: "auto", cwd: "/workspace/project" },
        tool("write", "write"),
        { path: "notes.txt" },
      ).behavior,
    ).toBe("allow");
    expect(
      evaluatePermission(
        { mode: "auto", cwd: "/workspace/project" },
        tool("write", "write"),
        { path: "/outside/notes.txt" },
      ).behavior,
    ).toBe("ask");
    expect(
      evaluatePermission(
        { mode: "auto", cwd: "/workspace/project" },
        tool("bash", "execute"),
        { command: "mkdir -p src/generated" },
      ).behavior,
    ).toBe("allow");
    expect(
      evaluatePermission(
        { mode: "auto", cwd: "/workspace/project" },
        tool("bash", "execute"),
        { command: "cp src/input.txt dist/output.txt" },
      ).behavior,
    ).toBe("allow");
    expect(
      evaluatePermission(
        { mode: "auto", cwd: "/workspace/project" },
        tool("bash", "execute"),
        { command: "curl https://example.com" },
      ).behavior,
    ).toBe("ask");
    expect(
      evaluatePermission(
        { mode: "auto", cwd: "/workspace/project" },
        tool("bash", "execute"),
        { command: "mkdir -p src/generated && rm -rf build" },
      ).behavior,
    ).toBe("ask");
    expect(
      evaluatePermission(
        { mode: "auto", cwd: "/workspace/project" },
        tool("bash", "execute"),
        { command: "mv ../secret.txt src/secret.txt" },
      ).behavior,
    ).toBe("ask");
  });

  test("downgrades YOLO outside trusted folders", () => {
    expect(
      evaluatePermission(
        {
          mode: "bypassPermissions",
          cwd: "/workspace/untrusted",
          trustedFolders: ["/workspace/trusted"],
        },
        tool("write", "write"),
        {},
      ).behavior,
    ).toBe("ask");
  });

  test("explains why YOLO is downgraded", () => {
    expect(
      resolvePermissionMode({ mode: "bypassPermissions", disableYolo: true }),
    ).toEqual({
      mode: "default",
      reason: "YOLO mode is disabled by settings",
    });
    expect(
      resolvePermissionMode({
        mode: "bypassPermissions",
        cwd: "/workspace/untrusted",
        trustedFolders: ["/workspace/trusted"],
      }),
    ).toEqual({
      mode: "default",
      reason: "YOLO mode is unavailable outside configured trusted folders",
    });
  });

  test("does not let allow rules override plan mode for mutating tools", () => {
    expect(
      evaluatePermission(
        { mode: "plan", rules: { allow: ["write"] } },
        tool("write", "write"),
        {},
      ).behavior,
    ).toBe("deny");
  });

  test("does not extend a Bash prefix allow rule across compound commands", () => {
    const bash = tool("Bash", "execute");
    const rules = { allow: ["Bash(npm test:*)"], deny: ["Bash(rm:*)"] };

    expect(
      evaluatePermission(
        { mode: "default", rules },
        bash,
        { command: "npm test && curl https://example.com" },
      ).behavior,
    ).toBe("ask");
    expect(
      evaluatePermission(
        { mode: "bypassPermissions", rules },
        bash,
        { command: "echo safe && rm -rf build" },
      ).behavior,
    ).toBe("deny");
  });
});
