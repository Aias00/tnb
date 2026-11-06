import { chmod, copyFile, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";
import { codingPluginFingerprint } from "../src/adapters/coding/identity";
import { buildCodingRecoveryPackage } from "../src/adapters/coding/recovery-package";
import { unpackPlugin } from "../src/agent/packed-plugin";
import { buildChannelsRecoveryPackage } from "../src/plugins/channels/recovery-package";
import packageJson from "../package.json";
import { buildPluginSdk } from "./build-plugin-sdk";

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
await buildPluginSdk(root, outputDirectory);
const codingPackage = await buildCodingRecoveryPackage(root);
const channelsPackage = await buildChannelsRecoveryPackage(root);
const gitValue = async (args: string[]) => {
  const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" });
  const text = (await new Response(child.stdout).text()).trim();
  return await child.exited === 0 ? text : null;
};
const commit = await gitValue(["rev-parse", "HEAD"]);
const changed = await gitValue(["status", "--porcelain", "--untracked-files=normal"]);
const sourceDigest = await codingPluginFingerprint(root);
const info = { version: packageJson.version, mode: "compiled", commit, dirty: changed === null ? null : Boolean(changed), builtAt: new Date().toISOString(), sourceDigest, bun: Bun.version, platform: process.platform, arch: process.arch };
const build = await Bun.build({ entrypoints: [join(root, "src/entrypoints/cli.ts")], target: "bun", compile: { outfile: join(outputDirectory, cliName) },
  define: { TNB_BUILD_INFO: JSON.stringify(info), TNB_BUILD_SOURCE_SHA256: JSON.stringify(sourceDigest), TNB_CODING_PACKAGE: JSON.stringify(codingPackage), TNB_CHANNELS_PACKAGE: JSON.stringify(channelsPackage) } });
if (!build.success) throw new AggregateError(build.logs, "CLI compilation failed");
await writeFile(join(outputDirectory, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
const pluginRoot = join(outputDirectory, "plugins", "tnb-coding");
await mkdir(pluginRoot, { recursive: true });
// The distributable package and embedded default contain the same bytes.
await rm(pluginRoot, { recursive: true, force: true });
await unpackPlugin(codingPackage, pluginRoot);

const channelsRoot = join(outputDirectory, "plugins", "tnb-channels"); await rm(channelsRoot, { recursive: true, force: true });
await unpackPlugin(channelsPackage, channelsRoot);
for (const name of ["collaboration", "web"]) {
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
