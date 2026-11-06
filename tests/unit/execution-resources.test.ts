import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadExecutionResources, loadConfiguredPlugins } from "../../src/services/execution/resources";
import { trustPlugin, revokePluginTrust, pluginTrustStorePath } from "../../src/services/plugins/trust";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "tnb-resources-")); roots.push(root);
  const configDir = join(root, "config"), cwd = join(root, "workspace"), plugin = join(configDir, "plugins", "pack");
  for (const dir of [cwd, join(plugin, "agents"), join(plugin, "commands"), join(plugin, "skills", "pack-skill")]) await mkdir(dir, { recursive: true });
  await writeFile(join(plugin, "plugin.json"), JSON.stringify({ name: "pack", version: "1.0.0", manifestVersion: 2, apiVersion: "tnb.plugin/v1", contributes: { adapters: [{ id: "test", version: "1", entry: "index.mjs" }] } }));
  await writeFile(join(plugin, "index.mjs"), 'throw new Error("RESOURCE_FACTORY_MUST_NOT_RUN");');
  await writeFile(join(plugin, "agents", "pack.md"), "---\nname: pack-agent\ndescription: packaged agent\n---\nRead only.");
  await writeFile(join(plugin, "commands", "pack.md"), "---\ndescription: packaged command\n---\nRead the package.");
  await writeFile(join(plugin, "skills", "pack-skill", "SKILL.md"), "---\nname: pack-skill\ndescription: packaged skill\n---\nRead package instructions.");
  return { configDir, cwd, plugin };
}

test("resource discovery gates all contribution types on trust, enablement and blocked content", async () => {
  const { configDir, cwd, plugin } = await setup();
  const cold = await loadExecutionResources({ configDir, cwd });
  expect(cold.agents.agents.some(agent => agent.name === "pack-agent")).toBe(false);
  expect(cold.commands.commands.some(command => command.name === "pack")).toBe(false);
  expect(cold.skills.some(skill => skill.name === "pack-skill")).toBe(false);
  await trustPlugin(pluginTrustStorePath(configDir), cold.plugins[0]!.root, cold.plugins[0]!.fingerprint);
  const active = await loadExecutionResources({ configDir, cwd });
  expect(active.agents.agents.some(agent => agent.name === "pack-agent")).toBe(true);
  expect(active.commands.commands.some(command => command.name === "pack")).toBe(true);
  expect(active.skills.some(skill => skill.name === "pack-skill")).toBe(true);
  for (const policy of [{ enabled: { pack: false } }, { blockedFingerprints: [active.plugins[0]!.fingerprint!] }]) {
    const revoked = await loadExecutionResources({ configDir, cwd, ...policy, catalog: active.plugins });
    expect(revoked.agents.agents.some(agent => agent.name === "pack-agent")).toBe(false);
    expect(revoked.skills.some(skill => skill.name === "pack-skill")).toBe(false);
    expect(revoked.commands.commands.some(command => command.name === "pack")).toBe(false);
  }
  await revokePluginTrust(pluginTrustStorePath(configDir), plugin);
  expect((await loadExecutionResources({ configDir, cwd })).plugins[0]!.active).toBe(false);
});

test("discovery preserves project precedence and detects changed resources on reload", async () => {
  const { configDir, cwd } = await setup();
  for (const root of [configDir, join(cwd, ".claude"), join(cwd, ".tnb")]) {
    await mkdir(join(root, "agents"), { recursive: true });
    await writeFile(join(root, "agents", "same.md"), `---\nname: same\ndescription: ${root}\n---\nInstructions from ${root}`);
  }
  const first = await loadExecutionResources({ configDir, cwd });
  expect(first.agents.agents.find(agent => agent.name === "same")?.source).toBe("project");
  await writeFile(join(cwd, ".tnb", "agents", "same.md"), "---\nname: same\ndescription: changed\n---\nNew instructions.");
  const second = await loadExecutionResources({ configDir, cwd });
  expect(second.signature).not.toBe(first.signature);
  expect(second.agents.agents.find(agent => agent.name === "same")?.prompt).toBe("New instructions.");
  expect((await loadConfiguredPlugins(configDir, cwd, undefined)).plugins).toHaveLength(1);
});
