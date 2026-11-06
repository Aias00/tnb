import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { constants } from "node:fs";
import { parseGitStatus } from "./review";
import type { WorkspaceObservation } from "../../core/tool";
export type ObservedChange = WorkspaceObservation["changes"][number];
type Snapshot = { root: string; hashes: Map<string, string>; unknown: Set<string>; partial: boolean };
async function boundedGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const child = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const stop = () => child.kill(); signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, 1500), reader = child.stdout.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 2 * 1024 * 1024) throw new Error("Observation output limit"); chunks.push(part.value); }
    if (await child.exited !== 0) throw new Error("Workspace observation unavailable");
    return Buffer.concat(chunks).toString("utf8");
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); child.kill(); await reader.cancel().catch(() => {}); await child.exited; }
}
async function snapshot(cwd: string, signal?: AbortSignal): Promise<Snapshot | undefined> {
  let root: string;
  try { root = await realpath((await boundedGit(cwd, ["rev-parse", "--show-toplevel"], signal)).trim()); } catch { return; }
  const [tracked, status, format] = await Promise.all([boundedGit(root, ["ls-files", "--stage", "-z"], signal), boundedGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal), boundedGit(root, ["rev-parse", "--show-object-format"], signal)]);
  const hashes = new Map<string, string>(), unknown = new Set<string>(); let partial = false, bytes = 0;
  const records = tracked.split("\0").filter(Boolean);
  for (const row of records.slice(0, 5000)) {
    const match = /^(100644|100755) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(row);
    if (match) hashes.set(match[3]!, match[2]!); else partial = true;
  }
  for (const row of records.slice(5000)) { const path = row.slice(row.indexOf("\t") + 1); unknown.add(path); }
  partial ||= records.length > 5000;
  const entries = parseGitStatus(status);
  for (const entry of entries.slice(200)) unknown.add(entry.path);
  for (const entry of entries.slice(0, 200)) {
    if (entry.path.startsWith(".tnb/")) { unknown.add(entry.path); hashes.delete(entry.path); continue; }
    const path = resolve(root, entry.path), inside = relative(root, path);
    if (inside === ".." || inside.startsWith(`..${sep}`)) { partial = true; continue; }
    const info = await lstat(path).catch(() => undefined);
    if (!info) { hashes.delete(entry.path); continue; }
    if (!info.isFile() || info.size > 256 * 1024 || bytes + info.size > 4 * 1024 * 1024) { partial = true; unknown.add(entry.path); hashes.delete(entry.path); continue; }
    const canonical = await realpath(path), location = relative(root, canonical);
    if (location === ".." || location.startsWith(`..${sep}`)) { partial = true; unknown.add(entry.path); hashes.delete(entry.path); continue; }
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let data: Buffer;
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > 256 * 1024) { partial = true; unknown.add(entry.path); continue; }
      const buffer = Buffer.alloc(256 * 1024 + 1), result = await file.read(buffer, 0, buffer.length, 0), after = await file.stat();
      if (result.bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) { partial = true; unknown.add(entry.path); continue; }
      data = buffer.subarray(0, result.bytesRead);
    } finally { await file.close(); }
    bytes += data.length;
    const algorithm = format.trim() === "sha256" ? "sha256" : "sha1";
    hashes.set(entry.path, createHash(algorithm).update(`blob ${data.length}\0`).update(data).digest("hex"));
  }
  partial ||= entries.length > 200;
  return { root, hashes, unknown, partial };
}
function compare(before: Snapshot, after: Snapshot, window: ObservedChange["window"]): ObservedChange[] {
  if (before.root !== after.root) return [];
  const changes: ObservedChange[] = [];
  for (const path of new Set([...before.hashes.keys(), ...after.hashes.keys()])) {
    if (before.unknown.has(path) || after.unknown.has(path)) continue;
    const a = before.hashes.get(path) ?? null, b = after.hashes.get(path) ?? null;
    if (a !== b) changes.push({ path, before: a, after: b, window });
    if (changes.length >= 200) break;
  }
  return changes;
}
/** Observation proves a version difference, never who caused it. No shell command is repeated. */
export class WorkspaceChangeObserver {
  private previous?: Snapshot;
  async begin(cwd: string, signal?: AbortSignal): Promise<{ before?: Snapshot; between: ObservedChange[] }> {
    const before = await snapshot(cwd, signal);
    return { before, between: before && this.previous ? compare(this.previous, before, "between-commands") : [] };
  }
  async end(cwd: string, start: Awaited<ReturnType<WorkspaceChangeObserver["begin"]>>, signal?: AbortSignal): Promise<WorkspaceObservation> {
    if (signal?.aborted) { this.previous = undefined; return { changes: start.between, partial: true }; }
    const after = await snapshot(cwd, signal); this.previous = after;
    const changes = [...start.between, ...(start.before && after ? compare(start.before, after, "during-command") : [])].slice(0, 200);
    return { changes, partial: !start.before || !after || start.before.partial || after.partial || changes.length >= 200 };
  }
}
