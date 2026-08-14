import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPlugins } from "../../src/services/plugins/loader";
import { computePluginTreeSha256, loadPluginMarketplace } from "../../src/services/plugins/marketplace";
import { pluginTrustStorePath, revokePluginTrust, trustPlugin } from "../../src/services/plugins/trust";
import {
  installLocalPlugin,
  loadPluginRuntimeCache,
  prunePluginRuntimeCache,
} from "../../src/services/plugins/management";
import { createExternalPluginTools } from "../../src/services/plugins/tools";
import { bundledSkills } from "../../src/services/skills/bundled";
import { loadSkills, renderSkillPrompt } from "../../src/services/skills/loader";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local plugins and bundled skills", () => {
  test("requires explicit trust and revokes activation when plugin content changes", async () => {
    const root = await temporary();
    const configDir = join(root, "config");
    const plugin = join(root, "plugins", "workspace-pack");
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, "plugin.json"), JSON.stringify({ name: "workspace-pack" }));
    const trustStore = pluginTrustStorePath(configDir);

    const first = await loadPlugins(
      [{ directory: join(root, "plugins"), source: "project" }],
      {},
      { trustStorePath: trustStore },
    );
    expect(first.plugins[0]).toMatchObject({ trust: "untrusted", active: false });

    await trustPlugin(trustStore, first.plugins[0]!.root, first.plugins[0]!.fingerprint);
    const trusted = await loadPlugins(
      [{ directory: join(root, "plugins"), source: "project" }],
      {},
      { trustStorePath: trustStore },
    );
    expect(trusted.plugins[0]).toMatchObject({ trust: "trusted", active: true });

    await writeFile(join(plugin, "plugin.json"), JSON.stringify({ name: "workspace-pack", description: "changed" }));
    const changed = await loadPlugins(
      [{ directory: join(root, "plugins"), source: "project" }],
      {},
      { trustStorePath: trustStore },
    );
    expect(changed.plugins[0]).toMatchObject({ trust: "changed", active: false });

    expect(await revokePluginTrust(trustStore, changed.plugins[0]!.root)).toBe(true);
    const revoked = await loadPlugins(
      [{ directory: join(root, "plugins"), source: "project" }],
      {},
      { trustStorePath: trustStore },
    );
    expect(revoked.plugins[0]).toMatchObject({ trust: "untrusted", active: false });
  });

  test("loads declared built-in tool contributions", async () => {
    const root = await temporary();
    const plugin = join(root, "plugins", "security-review");
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, "plugin.json"), JSON.stringify({
      name: "security-review",
      tools: ["builtin:security_scan"],
    }));
    const result = await loadPlugins([{ directory: join(root, "plugins"), source: "user" }]);
    expect(result.errors).toEqual([]);
    expect(result.plugins[0]?.tools).toEqual(["builtin:security_scan"]);
  });

  test("discovers a manifested plugin and loads its skill components", async () => {
    const root = await temporary();
    const plugin = join(root, "plugins", "review-pack");
    await mkdir(join(plugin, ".tnb-plugin"), { recursive: true });
    await mkdir(join(plugin, "skills", "focused-review"), { recursive: true });
    await writeFile(join(plugin, ".tnb-plugin", "plugin.json"), JSON.stringify({
      name: "review-pack",
      version: "1.0.0",
      description: "Review helpers",
    }));
    await writeFile(join(plugin, "skills", "focused-review", "SKILL.md"), `---\nname: focused-review\ndescription: Review one focused change\n---\nReview $ARGUMENTS`);

    const result = await loadPlugins([{ directory: join(root, "plugins"), source: "user" }]);
    expect(result.errors).toEqual([]);
    expect(result.plugins[0]?.name).toBe("review-pack");
    const skills = await loadSkills([
      { directory: result.plugins[0]!.skillsDir, source: "plugin" },
    ], bundledSkills());
    expect(skills.map(({ name }) => name)).toContain("focused-review");
    expect(skills.map(({ name }) => name)).toContain("skill-creator");
  });

  test("normalizes contributes metadata, compatibility, lifecycle, and external tool descriptors", async () => {
    const root = await temporary();
    const plugin = join(root, "plugins", "team-automation");
    await mkdir(join(plugin, ".tnb-plugin"), { recursive: true });
    await mkdir(join(plugin, "skills"), { recursive: true });
    await mkdir(join(plugin, "agents"), { recursive: true });
    await writeFile(join(plugin, ".tnb-plugin", "plugin.json"), JSON.stringify({
      name: "team-automation",
      manifestVersion: 2,
      version: "1.2.0",
      apiVersion: "tnb.plugin/v1",
      compatibility: {
        hosts: ["tnb", "claude-code"],
        minTnbVersion: "0.0.0",
        testedTnbVersions: ["0.0.0"],
      },
      documentation: {
        overview: "Workspace automation helpers.",
        whenToUse: "Use when the team wants shared review and audit helpers.",
        lifecycle: "Manual activation keeps the plugin dormant until enabled.",
        contributionNotes: ["Adds review hooks.", "Adds one external audit tool."],
        examples: ["tnb /plugins enable team-automation"],
        resources: ["./docs/overview.md"],
      },
      lifecycle: {
        activation: "manual",
        start: "eager",
        reload: "session",
        state: "workspace",
        events: ["SessionStart", "PostToolUse"],
      },
      contributes: {
        hooks: "./hooks.json",
        mcpServers: "./mcp.json",
        tools: [
          "builtin:security_scan",
          {
            id: "team.audit",
            type: "external",
            description: "Workspace audit tool run as a one-shot command.",
            command: "./bin/audit.js",
            args: ["--stdio"],
            inputSchema: "./schemas/audit.json",
            security: {
              access: "read",
              workspace: "read",
              approval: "always",
            },
            lifecycle: {
              transport: "oneshot",
              start: "lazy",
              reload: "runtime",
            },
          },
        ],
      },
    }));

    const result = await loadPlugins([{ directory: join(root, "plugins"), source: "user" }]);
    expect(result.errors).toEqual([]);
    const loaded = result.plugins[0]!;
    expect(loaded.active).toBe(false);
    expect(loaded.explicitlyEnabled).toBe(false);
    expect(loaded.manifestVersion).toBe(2);
    expect(loaded.apiVersion).toBe("tnb.plugin/v1");
    expect(loaded.compatibility).toEqual({
      hosts: ["tnb", "claude-code"],
      minTnbVersion: "0.0.0",
      testedTnbVersions: ["0.0.0"],
    });
    expect(loaded.documentation).toEqual({
      overview: "Workspace automation helpers.",
      whenToUse: "Use when the team wants shared review and audit helpers.",
      lifecycle: "Manual activation keeps the plugin dormant until enabled.",
      contributionNotes: ["Adds review hooks.", "Adds one external audit tool."],
      examples: ["tnb /plugins enable team-automation"],
      resources: [join(loaded.root, "docs", "overview.md")],
    });
    expect(loaded.lifecycle).toEqual({
      activation: "manual",
      start: "eager",
      reload: "session",
      state: "workspace",
      events: ["SessionStart", "PostToolUse"],
    });
    expect(loaded.hooksPath).toBe(join(loaded.root, "hooks.json"));
    expect(loaded.mcpPath).toBe(join(loaded.root, "mcp.json"));
    expect(loaded.tools).toEqual(["builtin:security_scan"]);
    expect(loaded.contributionSummary).toEqual({
      skills: true,
      agents: true,
      commands: false,
      hooks: true,
      mcpServers: true,
      builtInTools: ["builtin:security_scan"],
      externalTools: ["team.audit"],
    });
    expect(loaded.toolContributions).toEqual([
      {
        id: "builtin:security_scan",
        type: "builtin",
        toolName: "security_scan",
        description: "Run the enabled local SAST rules against workspace paths without executing scanned files.",
        access: "read",
        security: {
          access: "read",
          workspace: "read",
          network: "none",
          shell: false,
          approval: "inherit",
        },
        lifecycle: {
          transport: "in_process",
          start: "lazy",
          reload: "runtime",
        },
      },
      {
        id: "team.audit",
        type: "external",
        description: "Workspace audit tool run as a one-shot command.",
        command: join(loaded.root, "bin", "audit.js"),
        args: ["--stdio"],
        inputSchemaPath: join(loaded.root, "schemas", "audit.json"),
        security: {
          access: "read",
          workspace: "read",
          network: "none",
          shell: false,
          approval: "always",
        },
        lifecycle: {
          transport: "oneshot",
          start: "lazy",
          reload: "runtime",
        },
      },
    ]);

    const enabled = await loadPlugins([{ directory: join(root, "plugins"), source: "user" }], {
      "team-automation": true,
    });
    expect(enabled.plugins[0]).toMatchObject({ active: true, explicitlyEnabled: true });
  });

  test("activates one-shot external tool contributions", async () => {
    const root = await temporary();
    const plugin = join(root, "plugins", "echo-pack");
    await mkdir(join(plugin, "bin"), { recursive: true });
    await writeFile(join(plugin, "plugin.json"), JSON.stringify({
      name: "echo-pack",
      contributes: {
        tools: [{
          id: "echo.value",
          description: "Echo one JSON input.",
          command: "./bin/echo.sh",
          lifecycle: { transport: "oneshot" },
          security: { access: "read" },
        }],
      },
    }));
    await writeFile(join(plugin, "bin", "echo.sh"), "#!/bin/sh\nprintf 'received:'\ncat\n");
    await chmod(join(plugin, "bin", "echo.sh"), 0o755);

    const loaded = await loadPlugins([{ directory: join(root, "plugins"), source: "user" }]);
    const tools = await createExternalPluginTools(loaded.plugins, process.env);
    expect(tools.map((tool) => tool.name)).toEqual(["plugin__echo-pack__echo_value"]);
    const input = tools[0]!.validate({ value: "hello" });
    expect(await tools[0]!.execute(input, new AbortController().signal)).toBe('received:{"value":"hello"}');
  });

  test("rejects contribution symlinks that escape the plugin root", async () => {
    const root = await temporary();
    const plugin = join(root, "plugins", "escape-pack");
    const outside = join(root, "outside.sh");
    await mkdir(join(plugin, "bin"), { recursive: true });
    await writeFile(outside, "#!/bin/sh\necho escaped\n");
    await symlink(outside, join(plugin, "bin", "run.sh"));
    await writeFile(join(plugin, "plugin.json"), JSON.stringify({
      name: "escape-pack",
      contributes: { tools: [{ id: "escape.run", description: "Run", command: "./bin/run.sh" }] },
    }));
    const loaded = await loadPlugins([{ directory: join(root, "plugins"), source: "user" }]);
    await expect(createExternalPluginTools(loaded.plugins, process.env)).rejects.toThrow("escapes plugin root");
  });

  test("computes a stable plugin content digest and rejects symlinked trees", async () => {
    const root = await temporary();
    const plugin = join(root, "plugin");
    await mkdir(join(plugin, "nested"), { recursive: true });
    await writeFile(join(plugin, "plugin.json"), '{"name":"digest"}\n');
    await writeFile(join(plugin, "nested", "data.txt"), "content\n");
    const first = await computePluginTreeSha256(plugin);
    const second = await computePluginTreeSha256(plugin);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    await symlink(join(plugin, "nested", "data.txt"), join(plugin, "linked.txt"));
    await expect(computePluginTreeSha256(plugin)).rejects.toThrow("symbolic link");
  });

  test("lets user skills override bundled skills with the same name", async () => {
    const root = await temporary();
    const directory = join(root, "skills", "init");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `---\nname: init\ndescription: Custom initializer\n---\nCustom $ARGUMENTS`);
    const skills = await loadSkills([{ directory: join(root, "skills"), source: "user" }], bundledSkills());
    const init = skills.find(({ name }) => name === "init")!;
    expect(init.source).toBe("user");
    expect(renderSkillPrompt(init, "request")).toContain("Custom request");
  });

  test("loads bundled skills from on-disk SKILL resources", () => {
    const skills = bundledSkills();
    const debugSkill = skills.find(({ name }) => name === "debug-issue");
    expect(debugSkill).toBeDefined();
    expect(debugSkill?.baseDir.endsWith("/src/services/skills/bundled/debug-issue")).toBe(true);
    expect(debugSkill?.resources).toEqual(["references/debug-loop.md"]);
    const prompt = renderSkillPrompt(debugSkill!, "crash on startup");
    expect(prompt).toContain("Supporting resources");
    expect(prompt).toContain("references/debug-loop.md");
  });

  test("loads marketplace metadata for plugin discovery cards", async () => {
    const root = await temporary();
    const source = join(root, "marketplace.json");
    await writeFile(source, JSON.stringify({
      name: "Local Catalog",
      plugins: [{
        name: "security-review",
        version: "1.1.0",
        description: "Security-focused helpers.",
        whenToUse: "Use for sandbox and permissions work.",
        tags: ["security", "review"],
        capabilities: ["skill", "hook", "builtin-tool"],
        documentationUrl: "https://example.com/plugins/security-review",
        repository: "file:///tmp/security-review",
      }],
    }));

    const result = await loadPluginMarketplace([source]);
    expect(result.errors).toEqual([]);
    expect(result.plugins).toEqual([{
      name: "security-review",
      version: "1.1.0",
      description: "Security-focused helpers.",
      whenToUse: "Use for sandbox and permissions work.",
      tags: ["security", "review"],
      capabilities: ["skill", "hook", "builtin-tool"],
      documentationUrl: "https://example.com/plugins/security-review",
      repository: "file:///tmp/security-review",
      marketplace: "Local Catalog",
    }]);
  });

  test("rejects unpinned remote marketplace repositories", async () => {
    const root = await temporary();
    const source = join(root, "marketplace.json");
    await writeFile(source, JSON.stringify({
      plugins: [{
        name: "remote-plugin",
        version: "1.0.0",
        repository: "https://example.com/remote-plugin.git",
        ref: "v1.0.0",
      }],
    }));

    const result = await loadPluginMarketplace([source]);
    expect(result.plugins).toEqual([]);
    expect(result.errors[0]?.error).toContain("commit is required");
  });

  test("fails closed for incompatible plugin host and API versions", async () => {
    const root = await temporary();
    const pluginsRoot = join(root, "plugins");
    for (const [name, manifest] of [
      ["wrong-host", { name: "wrong-host", version: "1.0.0", compatibility: { hosts: ["claude-code"] } }],
      ["future-api", { name: "future-api", version: "1.0.0", apiVersion: "tnb.plugin/v2" }],
      ["future-host", { name: "future-host", version: "1.0.0", compatibility: { minTnbVersion: "9.0.0" } }],
    ] as const) {
      const directory = join(pluginsRoot, name, ".tnb-plugin");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "plugin.json"), JSON.stringify(manifest));
    }

    const result = await loadPlugins([{ directory: pluginsRoot, source: "user" }]);
    expect(result.plugins).toEqual([]);
    expect(result.errors.map((error) => error.error)).toEqual(expect.arrayContaining([
      expect.stringContaining("compatible host"),
      expect.stringContaining("Unsupported plugin apiVersion"),
      expect.stringContaining("requires tnb >= 9.0.0"),
    ]));
  });

  test("installs a local plugin atomically and returns relocated contribution paths", async () => {
    const root = await temporary();
    const source = join(root, "source", "review-pack");
    const targetRoot = join(root, "installed");
    await mkdir(join(source, ".tnb-plugin"), { recursive: true });
    await mkdir(join(source, "docs"), { recursive: true });
    await mkdir(join(source, "bin"), { recursive: true });
    await writeFile(join(source, ".tnb-plugin", "plugin.json"), JSON.stringify({
      name: "review-pack",
      version: "1.0.0",
      documentation: { resources: ["./docs/overview.md"] },
      contributes: {
        tools: [{
          id: "review.echo",
          description: "Echo review input",
          command: "./bin/review.sh",
          inputSchema: "./schemas/review.json",
        }],
      },
    }));
    await writeFile(join(source, "docs", "overview.md"), "# review");
    await writeFile(join(source, "bin", "review.sh"), "#!/bin/sh\ncat\n");

    const installed = await installLocalPlugin({ source, targetRoot, sourceType: "user" });

    const installedRoot = await realpath(join(targetRoot, "review-pack"));
    expect(installed.root).toBe(installedRoot);
    expect(installed.manifestPath).toBe(join(installedRoot, ".tnb-plugin", "plugin.json"));
    expect(installed.documentation?.resources).toEqual([join(installedRoot, "docs", "overview.md")]);
    expect(installed.toolContributions).toEqual([expect.objectContaining({
      id: "review.echo",
      command: join(installedRoot, "bin", "review.sh"),
      inputSchemaPath: join(installedRoot, "schemas", "review.json"),
    })]);
    expect((await loadPlugins([{ directory: targetRoot, source: "user" }])).plugins.map(({ name }) => name)).toEqual(["review-pack"]);
  });

  test("loads and prunes cached runtime states for removed plugins", async () => {
    const root = await temporary();
    const cacheDir = join(root, ".runtime");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, "session-a.json"), JSON.stringify([
      { name: "review-pack", status: "active", updatedAt: "2026-08-12T01:00:00.000Z", sessionId: "session-a", version: "1.0.0" },
      { name: "other-pack", status: "stopped", updatedAt: "2026-08-12T01:05:00.000Z", sessionId: "session-a" },
    ]));
    await writeFile(join(cacheDir, "session-b.json"), JSON.stringify([
      { name: "review-pack", status: "failed", updatedAt: "2026-08-12T02:00:00.000Z", sessionId: "session-b", error: "boom" },
    ]));

    const cache = await loadPluginRuntimeCache(cacheDir);
    expect(cache.get("review-pack")).toEqual(expect.objectContaining({
      sessions: 2,
      latest: expect.objectContaining({ status: "failed", sessionId: "session-b" }),
    }));

    await prunePluginRuntimeCache(cacheDir, "review-pack");

    const pruned = await loadPluginRuntimeCache(cacheDir);
    expect(pruned.has("review-pack")).toBe(false);
    expect(pruned.get("other-pack")).toEqual(expect.objectContaining({ sessions: 1 }));
    expect(JSON.parse(await readFile(join(cacheDir, "session-a.json"), "utf8"))).toEqual([
      { name: "other-pack", status: "stopped", updatedAt: "2026-08-12T01:05:00.000Z", sessionId: "session-a" },
    ]);
  });

  test("ignores internal hidden plugin directories used for runtime and trash state", async () => {
    const root = await temporary();
    const pluginsRoot = join(root, "plugins");
    await mkdir(join(pluginsRoot, "review-pack", ".tnb-plugin"), { recursive: true });
    await mkdir(join(pluginsRoot, ".runtime"), { recursive: true });
    await mkdir(join(pluginsRoot, ".removed", "review-pack-1"), { recursive: true });
    await mkdir(join(pluginsRoot, ".install-stage-123"), { recursive: true });
    await writeFile(join(pluginsRoot, "review-pack", ".tnb-plugin", "plugin.json"), JSON.stringify({
      name: "review-pack",
      version: "1.0.0",
    }));

    const result = await loadPlugins([{ directory: pluginsRoot, source: "user" }]);
    expect(result.plugins.map(({ name }) => name)).toEqual(["review-pack"]);
    expect(result.errors).toEqual([]);
  });
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tnb-plugin-"));
  directories.push(directory);
  return directory;
}
