import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runConfigCommand,
  runJobsCommand,
  runProviderCommand,
  runResourceListCommand,
} from "../../src/services/cli/management";
import { loadProviderCatalog } from "../../src/providers/config";
import { createSessionWorktree } from "../../src/services/worktree/manager";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tnb-management-"));
  directories.push(path);
  return path;
}

describe("provider management command", () => {
  test("probes text and tool-call streaming through the configured transport", async () => {
    const configDir = await temporaryDirectory();
    const requests: unknown[] = [];
    let stdout = "";
    const common = {
      env: {}, cwd: configDir, configDir,
      stdout: { write: (text: string) => { stdout += text; } },
      stderr: { write: () => undefined },
      transportFactory: () => ({
        async *stream(request: unknown) {
          requests.push(request);
          const toolProbe = (request as { tools: unknown[] }).tools.length > 0;
          if (toolProbe) {
            yield { type: "tool-start" as const, index: 0, id: "call-1", name: "provider_diagnostic" };
            yield { type: "tool-input" as const, index: 0, json: '{"value":"ok"}' };
            yield { type: "response-end" as const, reason: "tool-use" as const };
          } else {
            yield { type: "text" as const, index: 0, text: "OK" };
            yield { type: "response-end" as const, reason: "end-turn" as const };
          }
        },
      }),
    };
    expect(await runProviderCommand({ ...common, argv: ["provider", "test", "openai", "--model", "gpt-test", "--json"] })).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, model: "gpt-test", probe: "text", text: "OK" });
    stdout = "";
    expect(await runProviderCommand({ ...common, argv: ["provider", "test", "openai", "--model", "gpt-test", "--tools", "--json"] })).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, probe: "tool-use", toolCall: { name: "provider_diagnostic", input: { value: "ok" } } });
    expect(requests).toHaveLength(2);
  });

  test("adds a custom provider while storing only an environment reference", async () => {
    const configDir = await temporaryDirectory();
    let stdout = "";
    let stderr = "";
    const common = {
      env: { DEEPSEEK_API_KEY: "secret" },
      cwd: configDir,
      configDir,
      stdout: { write: (text: string) => { stdout += text; } },
      stderr: { write: (text: string) => { stderr += text; } },
    };

    expect(await runProviderCommand({
      ...common,
      argv: ["provider", "add", "deepseek", "--api", "openai-completions", "--base-url", "https://api.deepseek.com/v1", "--model", "deepseek-chat", "--api-key-env", "DEEPSEEK_API_KEY", "--header", "X-Client=tnb", "--compat-profile", "deepseek", "--sampling", "temperature=0.2"],
    })).toBe(0);
    const catalog = await loadProviderCatalog({ configDir, env: common.env });
    expect(catalog.providers.deepseek).toMatchObject({
      api: "openai-completions",
      apiKey: "secret",
      headers: { "X-Client": "tnb" },
      compat: { profile: "deepseek", supportsReasoningEffort: true, thinkingFormat: "deepseek" },
      models: [{ id: "deepseek-chat", contextWindow: 128_000, maxTokens: 16_384, samplingParams: { temperature: 0.2 } }],
    });
    expect(stdout).not.toContain("secret");
    expect(stderr).toBe("");

    stdout = "";
    expect(await runProviderCommand({
      ...common,
      argv: ["provider", "use", "deepseek", "--model", "deepseek-chat"],
    })).toBe(0);
    expect(stdout).toContain("deepseek/deepseek-chat");

    expect(await runProviderCommand({
      ...common,
      argv: ["provider", "model", "add", "deepseek", "deepseek-reasoner", "--reasoning", "--context-window", "64000", "--max-tokens", "8192"],
    })).toBe(0);
    expect(await runProviderCommand({
      ...common,
      argv: ["provider", "model", "default", "deepseek", "deepseek-reasoner"],
    })).toBe(0);
    const updated = await loadProviderCatalog({ configDir, env: common.env });
    expect(updated.providers.deepseek?.models.map(({ id }) => id)).toEqual([
      "deepseek-reasoner",
      "deepseek-chat",
    ]);
    expect(await runProviderCommand({
      ...common,
      argv: ["provider", "set", "deepseek", "--header", "X-Route=fast", "--tool-result-name"],
    })).toBe(0);
    expect(await runProviderCommand({
      ...common,
      argv: ["provider", "model", "set", "deepseek", "deepseek-reasoner", "--sampling", "top_p=0.9", "--header", "X-Model=reasoner"],
    })).toBe(0);
    const configured = await loadProviderCatalog({ configDir, env: common.env });
    expect(configured.providers.deepseek).toMatchObject({
      headers: { "X-Client": "tnb", "X-Route": "fast" },
      compat: { requiresToolResultName: true },
    });
    expect(configured.providers.deepseek?.models[0]).toMatchObject({
      id: "deepseek-reasoner",
      samplingParams: { top_p: 0.9 },
      headers: { "X-Model": "reasoner" },
    });
  });

  test("requires an explicit confirmation flag before removing a provider", async () => {
    const configDir = await temporaryDirectory();
    let stderr = "";
    const common = {
      env: {},
      cwd: configDir,
      configDir,
      stdout: { write: () => undefined },
      stderr: { write: (text: string) => { stderr += text; } },
    };
    await runProviderCommand({
      ...common,
      argv: ["provider", "add", "local", "--api", "openai-completions", "--base-url", "http://127.0.0.1:11434/v1", "--model", "coder"],
    });

    expect(await runProviderCommand({ ...common, argv: ["provider", "remove", "local"] })).toBe(1);
    expect(stderr).toContain("requires --yes");
    expect(await runProviderCommand({ ...common, argv: ["provider", "remove", "local", "--yes"] })).toBe(0);
  });
});

describe("configuration lifecycle", () => {
  test("lets ConfigChange hooks block a settings write", async () => {
    const configDir = await temporaryDirectory();
    const settingsPath = join(configDir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        ConfigChange: [{
          matcher: "user_settings",
          hooks: [{ type: "command", command: "printf blocked >&2; exit 2" }],
        }],
      },
    }));
    let stderr = "";
    expect(await runConfigCommand({
      argv: ["config", "set", "general.vimMode", "true"],
      env: {}, cwd: configDir, configDir,
      stdout: { write: () => undefined },
      stderr: { write: (text) => { stderr += text; } },
    })).toBe(1);
    expect(stderr).toContain("blocked");
    expect(JSON.parse(await readFile(settingsPath, "utf8")).general).toBeUndefined();
  });
});

describe("worktree job management command", () => {
  test("lists jobs and requires explicit removal confirmation", async () => {
    const root = await gitWorkspace();
    const state = await createSessionWorktree(root, "parallel/task");
    let stdout = "";
    let stderr = "";
    const common = {
      env: {},
      cwd: root,
      stdout: { write: (text: string) => { stdout += text; } },
      stderr: { write: (text: string) => { stderr += text; } },
    };

    expect(await runJobsCommand({ ...common, argv: ["jobs", "--json"] })).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      expect.objectContaining({ id: "parallel+task", path: state.worktreePath }),
    ]);

    expect(await runJobsCommand({ ...common, argv: ["rm", "parallel+task"] })).toBe(1);
    expect(stderr).toContain("requires --yes");
    expect(await runJobsCommand({ ...common, argv: ["rm", "parallel+task", "--yes"] })).toBe(0);
  });
});

describe("plugin management command", () => {
  test("shows plugin details with runtime cache and lists scope/runtime status", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const pluginRoot = join(configDir, "plugins", "review-pack");
    await mkdir(join(pluginRoot, ".tnb-plugin"), { recursive: true });
    await writeFile(join(pluginRoot, ".tnb-plugin", "plugin.json"), JSON.stringify({
      name: "review-pack",
      version: "1.2.0",
      description: "Review helpers",
      lifecycle: {
        activation: "manual",
        start: "eager",
        reload: "session",
        state: "user",
      },
      contributes: {
        tools: ["builtin:security_scan"],
      },
    }));
    await writeFile(join(configDir, "settings.json"), JSON.stringify({
      enabledPlugins: { "review-pack": true },
    }));
    await mkdir(join(configDir, "plugins", ".runtime"), { recursive: true });
    await writeFile(join(configDir, "plugins", ".runtime", "session-a.json"), JSON.stringify([
      { name: "review-pack", version: "1.2.0", status: "active", updatedAt: "2026-08-13T00:00:00.000Z", sessionId: "session-a" },
    ]));

    let stdout = "";
    let stderr = "";
    const common = {
      env: {},
      cwd,
      configDir,
      stdout: { write: (text: string) => { stdout += text; } },
      stderr: { write: (text: string) => { stderr += text; } },
    };

    expect(await runResourceListCommand({ ...common, argv: ["plugins", "trust", "review-pack", "--yes"] })).toBe(0);
    expect(stdout).toContain("Trusted plugin review-pack");
    stdout = "";
    expect(await runResourceListCommand({ ...common, argv: ["plugins", "show", "review-pack"] })).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      name: "review-pack",
      version: "1.2.0",
      scope: "user",
      active: true,
      trust: "trusted",
      lifecycle: { activation: "manual", start: "eager", reload: "session", state: "user" },
      contributionSummary: { builtInTools: ["builtin:security_scan"] },
      runtime: {
        sessions: 1,
        latest: { status: "active", sessionId: "session-a" },
        versions: ["1.2.0"],
      },
    });

    stdout = "";
    expect(await runResourceListCommand({ ...common, argv: ["plugins", "list", "--json"] })).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      expect.objectContaining({
        name: "review-pack",
        scope: "user",
        state: "user",
        runtimeStatus: "active",
      }),
    ]);
  });

  test("lists marketplace install state and supports tag/capability search", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    const pluginRoot = join(configDir, "plugins", "security-review");
    await mkdir(join(pluginRoot, ".tnb-plugin"), { recursive: true });
    await writeFile(join(pluginRoot, ".tnb-plugin", "plugin.json"), JSON.stringify({
      name: "security-review",
      version: "1.1.0",
    }));
    const marketplace = join(configDir, "marketplace.json");
    await writeFile(marketplace, JSON.stringify({
      name: "Community",
      plugins: [{
        name: "security-review",
        version: "1.1.0",
        description: "Security helpers",
        tags: ["security", "audit"],
        capabilities: ["skill", "builtin-tool"],
        repository: "file:///tmp/security-review",
      }, {
        name: "docs-writer",
        version: "0.3.0",
        description: "Docs helpers",
        tags: ["docs"],
        capabilities: ["skill"],
        repository: "file:///tmp/docs-writer",
      }],
    }));

    let stdout = "";
    let stderr = "";
    const code = await runResourceListCommand({
      argv: ["plugins", "search", "builtin-tool", "--json"],
      env: { TNB_PLUGIN_MARKETPLACE: marketplace },
      cwd,
      configDir,
      stdout: { write: (text: string) => { stdout += text; } },
      stderr: { write: (text: string) => { stderr += text; } },
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual([
      expect.objectContaining({
        name: "security-review",
        installed: true,
        installedScope: "user",
        installedVersion: "1.1.0",
      }),
    ]);
  });
});

async function gitWorkspace(): Promise<string> {
  const root = await temporaryDirectory();
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(stderr);
  };
  await git(["init", "-q"]);
  await git(["config", "user.email", "tnb@example.invalid"]);
  await git(["config", "user.name", "tnb test"]);
  await Bun.write(join(root, "tracked.txt"), "base\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "base"]);
  return root;
}
