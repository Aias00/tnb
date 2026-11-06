#!/usr/bin/env bun

import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import packageJson from "../package.json";
import { installLocalBundle, rollbackLocalBundle } from "../src/services/update/local-install";

const root = resolve(import.meta.dir, "..");
const prefix = resolve(optionValue("--prefix") ?? join(homedir(), ".local"));
const executableName = platform() === "win32" ? "tnb.exe" : "tnb";

if (process.argv.includes("--rollback")) {
  const result = await rollbackLocalBundle({ prefix, executableName });
  process.stdout.write(`Restored local installation: ${result.target}\nCommand: ${result.link}\n`);
} else {
  if (!process.argv.includes("--skip-build")) await run([process.execPath, "run", "build"]);
  const result = await installLocalBundle({ prefix, executableName, distribution: join(root, "dist"), version: packageJson.version });
  process.stdout.write(`Installed tnb ${packageJson.version} to ${result.target}\nCommand: ${result.link}\n`);
  if (result.previous) process.stdout.write(`Previous installation retained: ${result.previous}\n`);
  if (!process.env.PATH?.split(":").includes(dirname(result.link))) process.stdout.write(`Add ${dirname(result.link)} to PATH.\n`);
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
