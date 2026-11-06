import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { validateAgentTaskInput, type AgentTaskInput } from "../../agent/execution";
import { parseDeadline } from "../runtime/limits";

/** This parser performs no IPC, plugin imports, permission grants or owner startup. */
export async function readDomainSubmission(args: string[], cwd: string, originSessionId?: string): Promise<AgentTaskInput> {
  if (!args[1] || args[1].startsWith("--")) throw new Error('Usage: submit "objective" --adapter descriptor.json --namespace NAME');
  const flags = new Map<string, string>();
  const allowed = new Set(["--adapter", "--namespace", "--mode", "--provider", "--model", "--max-turns", "--max-retries", "--max-model-requests", "--compact-threshold", "--max-budget-usd", "--deadline", "--command-id", "--config-dir"]);
  for (let index = 2; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--no-start") { if (flags.has(flag)) throw new Error(`Duplicate option: ${flag}`); flags.set(flag, "true"); continue; }
    if (!allowed.has(flag)) throw new Error(`Domain submission does not accept ${flag}; declare business resources and capabilities in the adapter descriptor`);
    if (flags.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    const value = args[++index]; if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    flags.set(flag, value);
  }
  if (!flags.has("--adapter") || !flags.has("--namespace")) throw new Error("Domain submission requires --adapter descriptor.json and --namespace NAME");
  const path = resolve(cwd, flags.get("--adapter")!);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let adapter: unknown;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error("Adapter descriptor must be a regular JSON file of at most 64 KiB");
    const buffer = Buffer.alloc(65537); let size = 0;
    while (size < buffer.length) { const { bytesRead } = await file.read(buffer, size, buffer.length - size, size); if (!bytesRead) break; size += bytesRead; }
    if (size > 65536) throw new Error("Adapter descriptor exceeds 64 KiB");
    try { adapter = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))); }
    catch { throw new Error("Adapter descriptor must contain valid UTF-8 JSON"); }
  } finally { await file.close(); }
  const number = (flag: string) => flags.has(flag) ? Number(flags.get(flag)) : undefined;
  return validateAgentTaskInput({ commandId: flags.get("--command-id") ?? randomUUID(), objective: args[1], namespace: flags.get("--namespace"), adapter,
    mode: flags.get("--mode") ?? "auto", provider: flags.get("--provider"), model: flags.get("--model"), maxTurns: number("--max-turns"), maxRetries: number("--max-retries"),
    maxModelRequests: number("--max-model-requests"), compactThreshold: number("--compact-threshold"), maxCostUsd: number("--max-budget-usd"),
    deadline: flags.has("--deadline") ? parseDeadline(flags.get("--deadline")!) : undefined, originSessionId });
}
