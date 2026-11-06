import { basename } from "node:path";

export class WorkspaceFileIndex {
  private readonly cache = new Map<string, { at: number; files?: readonly string[]; pending?: Promise<readonly string[]> }>();
  private readonly choices = new Map<string, string[]>();
  constructor(private readonly scan: (root: string, signal: AbortSignal) => Promise<string[]>, private readonly ttl = 2000, private readonly now = Date.now) {}
  invalidate(root?: string) { if (root) this.cache.delete(root); else this.cache.clear(); }
  recent(root: string): readonly string[] { return this.choices.get(root) ?? []; }
  remember(root: string, path: string) {
    this.choices.set(root, [path, ...this.recent(root).filter(value => value !== path)].slice(0, 100));
    if (this.choices.size > 8) this.choices.delete(this.choices.keys().next().value!);
  }
  async files(root: string, signal: AbortSignal): Promise<readonly string[]> {
    if (signal.aborted) return [];
    let entry = this.cache.get(root);
    if (entry?.files && this.now() - entry.at < this.ttl) return entry.files;
    if (!entry?.pending) {
      entry = { at: this.now(), files: entry?.files };
      const current = entry;
      // One caller cancelling its suggestion must not cancel another caller's scan.
      const timeout = AbortSignal.timeout(3000);
      current.pending = this.scan(root, timeout).then(files => { current.files = files; current.at = this.now(); return files; }).catch(() => current.files ?? []).finally(() => { current.pending = undefined; });
      this.cache.delete(root); this.cache.set(root, current);
      if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
    }
    const files = await entry!.pending!;
    return signal.aborted ? [] : files;
  }
}

export function rankWorkspaceFiles(files: readonly string[], query: string, recent: readonly string[] = []): string[] {
  const needle = query.toLocaleLowerCase();
  const score = (path: string) => {
    const name = basename(path).toLocaleLowerCase(), lower = path.toLocaleLowerCase();
    let quality = name === needle ? 0 : name.startsWith(needle) ? 10 : name.includes(needle) ? 20 : lower.includes(needle) ? 30 : 100;
    if (quality === 100) { let cursor = 0; for (const char of lower) if (char === needle[cursor]) cursor++; if (cursor < needle.length) return Infinity; quality = 50; }
    const selected = recent.indexOf(path);
    return quality * 10000 + (selected < 0 ? 1000 : selected * 10) + path.length;
  };
  return files.map(path => ({ path, score: score(path) })).filter(item => Number.isFinite(item.score)).sort((a, b) => a.score - b.score || a.path.localeCompare(b.path)).map(item => item.path);
}

async function scanFiles(cwd: string, signal: AbortSignal): Promise<string[]> {
  if (signal.aborted) return [];
  let child;
  try { child = Bun.spawn(["rg", "--files", "-0", "--glob", "!node_modules/**", "--glob", "!dist/**"], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" }); }
  catch { return []; }
  const stop = () => child.kill();
  signal.addEventListener("abort", stop, { once: true });
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = 1024 * 1024 - length;
      chunks.push(next.value.subarray(0, remaining)); length += Math.min(remaining, next.value.length);
      if (length >= 1024 * 1024) { child.kill(); break; }
    }
    return Buffer.concat(chunks).toString("utf8").split("\0").slice(0, -1).filter(path => path && !/[\r\n"]/.test(path)).slice(0, 10_000);
  } finally {
    signal.removeEventListener("abort", stop);
    child.kill(); await reader.cancel().catch(() => {}); await child.exited;
  }
}

export const workspaceFileIndex = new WorkspaceFileIndex(scanFiles);
