import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { initializePlugin, validatePluginPackage, testPluginPackage } from "../../src/services/plugins/development";
import { definePlugin, defineTool, createServiceRef } from "../../src/plugin-sdk";

const repo = resolve(import.meta.dir, "../.."), roots: string[] = [];
let sdkTarball: string;
async function command(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, env: { ...process.env, PATH: [join(repo, "node_modules/.bin"), ...[process.env.PATH ?? ""]].join(delimiter) }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
beforeAll(async () => {
  const destination = await mkdtemp(join(tmpdir(), "tnb-plugin-sdk-package-")); roots.push(destination);
  const result = await command([process.execPath, join(repo, "scripts/build-plugin-sdk.ts"), "--outdir", destination], repo);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  sdkTarball = join(destination, (await readdir(destination)).find(name => name.endsWith(".tgz"))!);
}, 30000);
afterAll(async () => { if (process.platform === "win32") Bun.gc(true); for (const root of roots.reverse()) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

test("one SDK entry exposes typed author helpers without starting a host", async () => {
  const setup = () => {}; expect(definePlugin(setup)).toBe(setup);
  const tool = defineTool({ name: "test", description: "test", inputSchema: { type: "object" }, validate: () => ({}), async execute() { return "ok"; } });
  expect(await tool.execute({}, new AbortController().signal)).toBe("ok");
  expect(createServiceRef<{ read(): string }>({ id: "fixture", version: 1, scope: "contribution", methods: { read: true } }).name).toBe("fixture/v1");
});

for (const template of ["agent", "application", "channel"] as const) test(`packed SDK and ${template} TypeScript template work in an independent project`, async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-typed-author-")); roots.push(root);
  const project = join(root, "project");
  await initializePlugin(project, template, "typed-plugin", { language: "typescript", sdkTarball });
  const document = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  // Only the local tarball is installed by tests. The repository's existing compiler is a CLI on PATH,
  // not a type dependency. Normal generated projects install their own pinned compiler.
  delete document.devDependencies.typescript;
  await writeFile(join(project, "package.json"), JSON.stringify(document));
  const install = await command([process.execPath, "install", "--ignore-scripts", "--registry", "http://127.0.0.1:1"], project);
  expect(install.code, install.stdout + install.stderr).toBe(0);
  expect((await readdir(join(project, "node_modules"))).filter(name => !name.startsWith("."))).toEqual(["@tnb"]);
  const types = await readFile(join(project, "node_modules/@tnb/plugin-sdk/index.d.ts"), "utf8");
  expect(types).not.toMatch(/^import\s|\/\/\/\s*<reference|import\(["']|\b(?:Bun|RuntimeStore|DurableRuntime)\b/m);
  const check = await command([process.execPath, "run", "typecheck"], project);
  expect(check.code, check.stdout + check.stderr).toBe(0);
  const entry = join(project, "src/index.ts"), original = await readFile(entry, "utf8");
  await writeFile(entry, original + '\nimport type { HostPluginAPI } from "@tnb/plugin-sdk";\ndeclare const hostApi: HostPluginAPI;\nhostApi.registerChannel({ id: 123 });\n');
  expect((await command([process.execPath, "run", "typecheck"], project)).code).not.toBe(0); // Declarations actually enforce the host contract.
  await writeFile(entry, original);
  const built = await command([process.execPath, "run", "build"], project);
  expect(built.code, built.stdout + built.stderr).toBe(0);
  // Runtime artifact must work without the development SDK or compiler installed beside it.
  await rm(join(project, "node_modules"), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const validation = await validatePluginPackage(join(project, "package")); expect(validation.ok, JSON.stringify(validation)).toBe(true);
  if (template !== "agent" || process.platform !== "win32") {
    const smoke = await testPluginPackage(join(project, "package")); expect(smoke.ok, JSON.stringify(smoke)).toBe(true);
  }
  if (template === "application") {
    await writeFile(entry, "export default ( =>");
    expect((await command([process.execPath, "run", "build"], project)).code).not.toBe(0);
    expect(await Bun.file(join(project, "package/plugin.json")).exists()).toBe(false);
  }
}, 30000);

test("TypeScript creation rejects absent SDK artifacts before creating a partial project", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-missing-sdk-")); roots.push(root);
  await expect(initializePlugin(join(root, "project"), "application", "fixture", { language: "typescript", sdkTarball: join(root, "absent.tgz") })).rejects.toThrow("Plugin SDK tarball not found");
  expect(await readdir(root)).toEqual([]);
});
