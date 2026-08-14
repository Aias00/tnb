#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  KNOWN_PROVIDER_SMOKE_CASES,
  mergeProviderSmokeSummaries,
  renderProviderSmokeSummary,
  runConfiguredProviderSmokeMatrix,
  runProviderSmokeMatrix,
} from "../src/providers/smoke-matrix";
import { loadProviderCatalog } from "../src/providers/config";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const includeConfigured = args.includes("--configured");
const requested = args.filter((argument) => argument !== "--configured");
const knownIds = new Set<string>(KNOWN_PROVIDER_SMOKE_CASES.map((provider) => provider.id));
const requestedKnown = requested.filter((id) => knownIds.has(id));
const requestedConfigured = requested.filter((id) => !knownIds.has(id));
const configDir = process.env.TNB_HOME ?? join(homedir(), ".tnb");

const runCommand = async (commandArgs: string[], env: Record<string, string | undefined>) => {
  const child = Bun.spawn(["bun", ...commandArgs], {
    cwd: root,
    env: env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
};

const summaries = [await runProviderSmokeMatrix({
  providers: requested.length ? requestedKnown : undefined,
  env: process.env,
  cwd: root,
  runCommand,
})];

if (includeConfigured || requestedConfigured.length) {
  const configuredIds = includeConfigured
    ? await readConfiguredProviderIds(configDir)
    : requestedConfigured;
  const catalog = await loadProviderCatalog({ configDir, env: process.env });
  summaries.push(await runConfiguredProviderSmokeMatrix({
    providers: configuredIds,
    catalog,
    env: process.env,
    runCommand,
  }));
}

const summary = mergeProviderSmokeSummaries(...summaries);

process.stdout.write(renderProviderSmokeSummary(summary));
if (summary.failed > 0) process.exit(1);

async function readConfiguredProviderIds(directory: string): Promise<string[]> {
  const path = join(directory, "models.json");
  const value = JSON.parse(await readFile(path, "utf8")) as { providers?: Record<string, unknown> };
  return Object.keys(value.providers ?? {});
}
