import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSettings } from "../../src/services/settings/load";
import { addProjectPermissionRule } from "../../src/services/settings/write";
import type { HooksConfig } from "../../src/services/hooks/runner";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tnb-settings-"));
  directories.push(directory);
  return directory;
}

describe("settings loading", () => {
  test("atomically adds and deduplicates project-local permission rules", async () => {
    const cwd = await temporaryDirectory();
    await addProjectPermissionRule({ cwd, behavior: "allow", rule: "Bash(bun test)" });
    await addProjectPermissionRule({ cwd, behavior: "allow", rule: "Bash(bun test)" });

    expect(await loadSettings({ configDir: await temporaryDirectory(), cwd })).toMatchObject({
      permissions: { allow: ["Bash(bun test)"] },
    });
  });
  test("merges user, project, and local permission settings in precedence order", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    await mkdir(join(cwd, ".tnb"));
    await writeFile(
      join(configDir, "settings.json"),
      JSON.stringify({ fastMode: true, permissions: { allow: ["read"], defaultMode: "default" } }),
    );
    await writeFile(
      join(cwd, ".tnb", "settings.json"),
      JSON.stringify({ provider: "openai", model: "gpt-user", permissions: { allow: ["bash(npm test:*)"], ask: ["write"] } }),
    );
    await writeFile(
      join(cwd, ".tnb", "settings.local.json"),
      JSON.stringify({
        provider: "local", model: "local-coder",
        permissions: { deny: ["bash(npm publish:*)"], defaultMode: "auto" },
        security: { disableYolo: true, trustedFolders: [cwd] },
      }),
    );

    expect(await loadSettings({ configDir, cwd })).toEqual({
      provider: "local",
      model: "local-coder",
      fastMode: true,
      permissions: {
        allow: ["read", "bash(npm test:*)"],
        ask: ["write"],
        deny: ["bash(npm publish:*)"],
        defaultMode: "auto",
      },
      security: { disableYolo: true, trustedFolders: [cwd] },
    });
  });

  test("applies a temporary file or JSON settings overlay last", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    await writeFile(join(configDir, "settings.json"), JSON.stringify({ provider: "anthropic", fastMode: false }));
    const overlay = join(cwd, "session-settings.json");
    await writeFile(overlay, JSON.stringify({ provider: "openai", model: "gpt-test" }));

    expect(await loadSettings({ configDir, cwd, additional: overlay })).toMatchObject({
      provider: "openai",
      model: "gpt-test",
      fastMode: false,
    });
    expect(await loadSettings({ configDir, cwd, additional: '{"fastMode":true}' })).toMatchObject({
      provider: "anthropic",
      fastMode: true,
    });
  });

  test("rejects malformed complete settings instead of silently ignoring them", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    await writeFile(join(configDir, "settings.json"), "{invalid}");

    await expect(loadSettings({ configDir, cwd })).rejects.toThrow("Invalid settings JSON");
  });

  test("rejects a non-boolean fast mode preference", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    await writeFile(join(configDir, "settings.json"), JSON.stringify({ fastMode: "yes" }));

    await expect(loadSettings({ configDir, cwd })).rejects.toThrow("fastMode must be boolean");
  });

  test("loads project hooks only when the user settings trust the workspace", async () => {
    const configDir = await temporaryDirectory();
    const cwd = await temporaryDirectory();
    await mkdir(join(cwd, ".tnb"));
    const projectHooks: HooksConfig = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "exit 2" }] }],
    };
    await writeFile(join(cwd, ".tnb", "settings.json"), JSON.stringify({ hooks: projectHooks }));

    const untrusted = await loadSettings({ configDir, cwd });
    expect(untrusted.hooks).toBeUndefined();
    expect(untrusted.warnings).toHaveLength(1);

    await writeFile(
      join(configDir, "settings.json"),
      JSON.stringify({ security: { trustedFolders: [cwd] } }),
    );
    const trusted = await loadSettings({ configDir, cwd });
    expect(trusted.hooks).toEqual(projectHooks);
    expect(trusted.warnings).toBeUndefined();
  });
});
