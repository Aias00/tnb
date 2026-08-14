import { chmod, copyFile, cp, mkdir, readdir } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";

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
], { cwd: root, stdout: "inherit", stderr: "inherit" });
const exitCode = await build.exited;
if (exitCode !== 0) process.exit(exitCode);

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
await cp(
  join(root, "src", "services", "skills", "bundled"),
  join(outputDirectory, "skills", "bundled"),
  { recursive: true, force: true },
);

process.stdout.write(`Built ${join(outputDirectory, cliName)} with TypeScript semantic-analysis companion and bundled skill resources\n`);
