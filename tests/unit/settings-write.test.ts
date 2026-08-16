import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addProjectPermissionRule, setUserSetting } from "../../src/services/settings/write";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("settings writes", () => {
  test("preserves concurrent permission rule updates", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tnb-settings-"));
    roots.push(cwd);
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      addProjectPermissionRule({ cwd, behavior: "allow", rule: `Bash(command-${index})` })
    ));

    const settings = JSON.parse(await readFile(join(cwd, ".tnb", "settings.local.json"), "utf8")) as {
      permissions: { allow: string[] };
    };
    expect(settings.permissions.allow.sort()).toEqual(
      Array.from({ length: 12 }, (_, index) => `Bash(command-${index})`).sort(),
    );
  });

  test("preserves independent concurrent user settings", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "tnb-user-settings-"));
    roots.push(configDir);
    await Promise.all([
      setUserSetting(configDir, "autoMemoryEnabled", false),
      setUserSetting(configDir, "provider", "yuanjing"),
      setUserSetting(configDir, "model", "glm-5"),
    ]);
    expect(JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"))).toMatchObject({
      autoMemoryEnabled: false,
      provider: "yuanjing",
      model: "glm-5",
    });
  });
});
