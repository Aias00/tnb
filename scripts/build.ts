import { chmod, copyFile, cp, mkdir, readdir } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";
import { codingPluginFingerprint } from "../src/adapters/coding/identity";

const root = resolve(import.meta.dir, "..");
const outputDirectory = join(root, "dist");
const cliName = platform() === "win32" ? "tnb.exe" : "tnb";
const compilerName = platform() === "win32" ? "tnb-tsgo.exe" : "tnb-tsgo";
const packagePlatform = platform() === "win32" ? "win32" : platform();
const packageArchitecture = arch() === "x64" ? "x64" : arch();
const nativePackage = join(
  root,
  "node_modules",
  "@typescript",
  `typescript-${packagePlatform}-${packageArchitecture}`,
);
const nativeLibrary = join(nativePackage, "lib");

await mkdir(outputDirectory, { recursive: true });
const build = Bun.spawn([
  process.execPath,
  "build",
  join(root, "src", "entrypoints", "cli.ts"),
  "--compile",
  `--outfile=${join(outputDirectory, cliName)}`,
  `--define=TNB_BUILD_SOURCE_SHA256=${JSON.stringify(await codingPluginFingerprint(root))}`,
], { cwd: root, stdout: "inherit", stderr: "inherit" });
const exitCode = await build.exited;
if (exitCode !== 0) process.exit(exitCode);
const pluginRoot = join(outputDirectory, "plugins", "tnb-coding");
await mkdir(pluginRoot, { recursive: true });
const plugin = await Bun.build({ entrypoints: [join(root, "src/adapters/coding/plugin.ts")], target: "bun", outdir: pluginRoot, naming: "index.mjs" });
if (!plugin.success) throw new AggregateError(plugin.logs, "Coding plugin bundle failed");
await copyFile(join(root, "src/adapters/coding/plugin.json"), join(pluginRoot, "plugin.json"));
await cp(join(root, "src/services/skills/bundled"), join(pluginRoot, "bundled"), { recursive: true, force: true });

for (const name of ["channels", "collaboration", "web"]) {
  const target = join(outputDirectory, "plugins", `tnb-${name}`); await mkdir(target, { recursive: true });
  const result = await Bun.build({ entrypoints: [join(root, "src/plugins", name, "plugin.ts")], target: "bun", outdir: target, naming: "index.mjs" });
  if (!result.success) throw new AggregateError(result.logs, `${name} plugin bundle failed`);
  await copyFile(join(root, "src/plugins", name, "plugin.json"), join(target, "plugin.json"));
}

const nativeExecutable = join(nativeLibrary, platform() === "win32" ? "tsc.exe" : "tsc");
const companionExecutable = join(outputDirectory, compilerName);
await copyFile(nativeExecutable, companionExecutable);
if (platform() !== "win32") await chmod(companionExecutable, 0o755);
for (const entry of await readdir(nativeLibrary, { withFileTypes: true })) {
  if (entry.isFile() && /^lib.*\.d\.ts$/.test(entry.name)) {
    await copyFile(join(nativeLibrary, entry.name), join(outputDirectory, entry.name));
  }
}
await copyFile(join(nativePackage, "NOTICE.txt"), join(outputDirectory, "typescript-NOTICE.txt"));
await cp(join(root, "third_party", "licenses"), join(outputDirectory, "licenses"), { recursive: true, force: true });
await cp(
  join(root, "src", "services", "skills", "bundled"),
  join(outputDirectory, "skills", "bundled"),
  { recursive: true, force: true },
);
for (const name of ["node-pty", `node-pty-${platform()}-${arch()}`]) {
  await cp(join(root, "node_modules", "@lydell", name), join(outputDirectory, "node_modules", "@lydell", name),
    { recursive: true, force: true, dereference: true });
}

process.stdout.write(`Built ${join(outputDirectory, cliName)} with TypeScript, PTY companions and bundled skill resources\n`);
