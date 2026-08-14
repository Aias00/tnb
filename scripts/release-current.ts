#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";

import packageJson from "../package.json";

const root = resolve(import.meta.dir, "..");
const version = packageJson.version;
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) || version === "0.0.0") {
  throw new Error(`package.json must contain a releasable semantic version, received ${version}`);
}
const target = `${platform()}-${arch()}`;
const releaseRoot = join(root, "release");
const stageName = `tnb-v${version}-${target}`;
const stage = join(releaseRoot, stageName);
const archive = join(releaseRoot, `${stageName}.tar.gz`);
const binaryAsset = join(releaseRoot, `${stageName}-binary${platform() === "win32" ? ".exe" : ""}`);

if (!process.argv.includes("--skip-build")) await run([process.execPath, "run", "build"]);
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(join(root, "dist"), join(stage, "dist"), { recursive: true, force: true });
await copyFile(join(root, "README.md"), join(stage, "README.md"));
await copyFile(join(root, "LICENSE"), join(stage, "LICENSE"));
await writeFile(join(stage, "VERSION"), `${version}\n`, "utf8");
await copyFile(join(root, "dist", platform() === "win32" ? "tnb.exe" : "tnb"), binaryAsset);
if (platform() !== "win32") await chmod(binaryAsset, 0o755);

await rm(archive, { force: true });
await run(["tar", "-czf", archive, "-C", releaseRoot, stageName]);
const checksums = [archive, binaryAsset];
const checksumText = `${(await Promise.all(checksums.map(async (path) => `${await sha256(path)}  ${path.split("/").at(-1)}`))).join("\n")}\n`;
await writeFile(join(releaseRoot, "SHA256SUMS"), checksumText, "utf8");

const baseUrl = process.env.TNB_RELEASE_BASE_URL?.replace(/\/+$/, "");
if (baseUrl) {
  await writeFile(join(releaseRoot, "manifest.json"), `${JSON.stringify({
    version,
    url: `${baseUrl}/${binaryAsset.split("/").at(-1)}`,
    sha256: await sha256(binaryAsset),
    notes: `tnb ${version} for ${target}`,
  }, null, 2)}\n`, "utf8");
}

process.stdout.write(`Created ${archive}\nCreated ${binaryAsset}\nCreated ${join(releaseRoot, "SHA256SUMS")}\n`);
if (!baseUrl) process.stdout.write("Set TNB_RELEASE_BASE_URL to also generate release/manifest.json.\n");

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command[0]} exited with code ${exitCode}`);
}
