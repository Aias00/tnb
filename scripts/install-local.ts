#!/usr/bin/env bun

import { cp, lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import packageJson from "../package.json";

const root = resolve(import.meta.dir, "..");
const prefix = resolve(optionValue("--prefix") ?? join(homedir(), ".local"));
const executableName = platform() === "win32" ? "tnb.exe" : "tnb";
const versionsRoot = join(prefix, "lib", "tnb");
const target = join(versionsRoot, packageJson.version);
const stage = join(versionsRoot, `.install-${packageJson.version}-${process.pid}`);
const link = join(prefix, "bin", executableName);
const temporaryLink = `${link}.${process.pid}.tmp`;

if (!process.argv.includes("--skip-build")) await run([process.execPath, "run", "build"]);
await mkdir(versionsRoot, { recursive: true });
await mkdir(dirname(link), { recursive: true });
await rm(stage, { recursive: true, force: true });
await cp(join(root, "dist"), stage, { recursive: true, force: true });
await rm(target, { recursive: true, force: true });
await rename(stage, target);

const previousTarget = await existingLinkTarget(link);
await rm(temporaryLink, { force: true });
await symlink(join(target, executableName), temporaryLink);
await rename(temporaryLink, link);
if (previousTarget && previousTarget !== join(target, executableName)) {
  const previousLink = `${link}.previous`;
  await rm(previousLink, { force: true });
  await symlink(previousTarget, previousLink);
}

process.stdout.write(`Installed tnb ${packageJson.version} to ${target}\n`);
process.stdout.write(`Command: ${link}\n`);
if (!process.env.PATH?.split(":").includes(dirname(link))) {
  process.stdout.write(`Add ${dirname(link)} to PATH.\n`);
}

async function existingLinkTarget(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    return info.isSymbolicLink() ? resolve(dirname(path), await readlink(path)) : undefined;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command[0]} exited with code ${exitCode}`);
}
