import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializePlugin, validatePluginPackage, testPluginPackage } from "../../src/services/plugins/development";
import { runResourceListCommand } from "../../src/services/cli/management";
import { loadPlugins, loadPluginDirectory } from "../../src/services/plugins/loader";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-plugin-author-")); cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const directory = join(root, "my-plugin"), configDir = join(root, "config");
  await mkdir(configDir); await writeFile(join(configDir, "settings.json"), '{"enabledPlugins":{"existing":false}}');
  async function cli(...argv: string[]) {
    let stdout = "", stderr = "";
    const code = await runResourceListCommand({ argv: ["plugins", ...argv], cwd: root, configDir, env: {}, stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } } });
    return { code, stdout, stderr };
  }
  return { root, directory, configDir, cli };
}

for (const template of ["agent", "application", "channel"] as const) {
  test.skipIf(template === "agent" && process.platform === "win32")(`${template} template works as a standalone package through the actual install/trust/host path`, async () => {
    const f = await fixture();
    const initialized = await f.cli("init", "my-plugin", "--template", template, "--json");
    expect(initialized.code, initialized.stderr).toBe(0); expect(JSON.parse(initialized.stdout).template).toBe(template);
    expect((await readdir(f.directory)).sort()).toEqual(["README.md", "index.mjs", "plugin.json", "plugin.test.json", ...(template === "agent" ? ["task.json"] : [])]);
    const validated = await f.cli("validate", "my-plugin", "--json");
    expect(validated.code, validated.stdout).toBe(0); expect(JSON.parse(validated.stdout).plugin.name).toBe("my-plugin");
    expect((await f.cli("test", "my-plugin")).stderr).toContain("--yes");
    const smoke = await f.cli("test", "my-plugin", "--yes", "--json");
    expect(smoke.code, smoke.stdout + smoke.stderr).toBe(0);
    expect(JSON.parse(smoke.stdout)).toMatchObject({ ok: true, isolatedState: true });
    expect(JSON.parse(smoke.stdout).checks.at(-1)).toMatchObject({ phase: "shutdown", ok: true });
    expect(await readdir(f.configDir)).toEqual(["settings.json"]);
    expect(await readFile(join(f.configDir, "settings.json"), "utf8")).toBe('{"enabledPlugins":{"existing":false}}');
    const repeated = await f.cli("test", "my-plugin", "--yes", "--json");
    expect(repeated.code, repeated.stdout + repeated.stderr).toBe(0); // Fresh state; initialization and command receipts do not leak across tests.
  });
}

test("validation uses exactly the requested package, does not import code, and agrees with discovery", async () => {
  const f = await fixture(); await initializePlugin(f.directory, "application");
  const marker = join(f.root, "imported");
  await writeFile(join(f.directory, "index.mjs"), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'bad');export default ()=>{};`);
  await mkdir(join(f.root, "aaa-sibling"));
  await writeFile(join(f.root, "aaa-sibling", "plugin.json"), await readFile(join(f.directory, "plugin.json")));
  const validation = await validatePluginPackage(f.directory);
  expect(validation.ok).toBe(true);
  expect(await Bun.file(marker).exists()).toBe(false);
  expect((await loadPluginDirectory(f.directory)).root).toBe(validation.directory);
  const discovered = await loadPlugins([{ directory: f.root, source: "user" }]);
  expect(discovered.plugins.find(row => row.name === "my-plugin")?.root).not.toBe(validation.directory); // A sibling with the same package name cannot shadow direct validation.
});

test("invalid entry syntax, missing default, missing entries and malformed scenarios fail before any plugin import", async () => {
  const f = await fixture(); await initializePlugin(f.directory, "application");
  const entry = join(f.directory, "index.mjs"), original = await readFile(entry, "utf8");
  await writeFile(entry, "export default ( =>");
  expect((await validatePluginPackage(f.directory)).ok).toBe(false);
  await writeFile(entry, "export const setup = () => {};");
  expect((await validatePluginPackage(f.directory)).checks.at(-1)?.detail).toContain("default factory");
  await rm(entry);
  expect((await validatePluginPackage(f.directory)).ok).toBe(false);
  await writeFile(entry, original);
  const spec = JSON.parse(await readFile(join(f.directory, "plugin.test.json"), "utf8"));
  spec.scenarios[0].expect.statuus = 200;
  await writeFile(join(f.directory, "plugin.test.json"), JSON.stringify(spec));
  const result = await f.cli("validate", "my-plugin", "--json");
  expect(result.code).toBe(1); expect(JSON.parse(result.stdout).checks.at(-1).detail).toContain("Unknown plugin test field");
});

test("factory declaration mismatches and wrong expected results fail the smoke command", async () => {
  const f = await fixture(); await initializePlugin(f.directory, "application");
  const entry = join(f.directory, "index.mjs"), original = await readFile(entry, "utf8");
  await writeFile(entry, "export default () => {};");
  expect((await validatePluginPackage(f.directory)).ok).toBe(true); // Static checks do not pretend to execute registration.
  let result = await testPluginPackage(f.directory);
  expect(result.ok).toBe(false); expect(result.checks.some(row => !row.ok && row.detail.includes("register"))).toBe(true);
  await writeFile(entry, original);
  const spec = JSON.parse(await readFile(join(f.directory, "plugin.test.json"), "utf8"));
  spec.scenarios[0].expect.json.visits = 100;
  await writeFile(join(f.directory, "plugin.test.json"), JSON.stringify(spec));
  const cli = await f.cli("test", "my-plugin", "--yes", "--json");
  expect(cli.code).toBe(1); expect(JSON.parse(cli.stdout).checks.some((row: any) => row.detail.includes("JSON expectation failed"))).toBe(true);
});

test.skipIf(process.platform === "win32")("a model report and permissive domain acceptance cannot substitute for a successful expected tool receipt", async () => {
  const f = await fixture(); await initializePlugin(f.directory, "agent");
  const entry = join(f.directory, "index.mjs"), original = await readFile(entry, "utf8");
  const beforeAccept = original.slice(0, original.indexOf("  async accept("));
  await writeFile(entry, beforeAccept.replace('async execute() { context.signal.throwIfAborted(); return message; }', 'async execute() { throw new Error("fixture failure"); }') + '  async accept() { return { checks: [{ command: "fixture", output: "Permissive fixture acceptance" }] }; },\n});\n');
  const result = await testPluginPackage(f.directory);
  expect(result.ok).toBe(false);
  expect(result.checks.find(row => !row.ok)).toMatchObject({ phase: "scenario-1", detail: "Task scenario 1: missing successful confirmed tool receipt: read_message" });
});

test("init refuses to overwrite existing paths; flags and scenarios cannot be silently ignored", async () => {
  const f = await fixture();
  expect((await f.cli("init", "my-plugin", "--template", "typo")).code).toBe(1);
  expect(await Bun.file(join(f.directory, "plugin.json")).exists()).toBe(false);
  await initializePlugin(f.directory, "channel");
  const original = await readFile(join(f.directory, "index.mjs"), "utf8");
  expect((await f.cli("init", "my-plugin")).code).toBe(1);
  expect(await readFile(join(f.directory, "index.mjs"), "utf8")).toBe(original);
  expect((await f.cli("test", "my-plugin", "--yes", "--force")).code).toBe(1);
  expect((await f.cli("validate", "my-plugin", "--yes")).code).toBe(1);
  await rm(join(f.directory, "plugin.test.json"));
  expect((await validatePluginPackage(f.directory)).ok).toBe(true);
  const result = await testPluginPackage(f.directory);
  expect(result.ok).toBe(false); expect(result.checks[0]?.detail).toContain("at least one scenario");
});
