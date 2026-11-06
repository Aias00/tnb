import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type FileChangedEvent = "change" | "add" | "unlink";

export class HookFileWatcher {
  private watchers: FSWatcher[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private existence = new Map<string, boolean>();
  private versions = new Map<string, string | undefined>();
  private polling?: ReturnType<typeof setInterval>;
  private scanning = false;
  private generation = 0;
  private readErrors = new Set<string>();

  constructor(private options: {
    cwd: string;
    matchers: string[];
    onChange(path: string, event: FileChangedEvent): Promise<void>;
    onError?(message: string): void;
    watch?: typeof watch;
    pollIntervalMs?: number;
  }) {}

  async start(): Promise<void> {
    await this.restart();
  }

  async setCwd(cwd: string): Promise<void> {
    if (cwd === this.options.cwd) return;
    this.options.cwd = cwd;
    await this.restart();
  }

  close(): void {
    this.generation++;
    if (this.polling) clearInterval(this.polling);
    this.polling = undefined;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async restart(): Promise<void> {
    this.close();
    this.existence.clear(); this.versions.clear(); this.readErrors.clear();
    const generation = this.generation;
    const targets = [...new Set(this.options.matchers.flatMap((matcher) =>
      matcher.split("|").map((value) => value.trim()).filter(Boolean)
    ).map((path) => resolve(this.options.cwd, path)))];
    const byDirectory = new Map<string, Set<string>>();
    for (const target of targets) {
      const version = await this.readVersion(target);
      if (generation !== this.generation) return;
      if (version !== null) { this.existence.set(target, version !== undefined); this.versions.set(target, version); }
      const directory = dirname(target);
      const group = byDirectory.get(directory) ?? new Set<string>();
      group.add(target);
      byDirectory.set(directory, group);
    }
    for (const [directory, group] of byDirectory) {
      try {
        const watcher = (this.options.watch ?? watch)(directory, { persistent: false }, (_event, filename) => {
          if (generation !== this.generation || !filename) return;
          const changed = resolve(directory, filename.toString());
          if (group.has(changed)) this.schedule(changed);
        });
        watcher.on("error", (error) => this.options.onError?.(`FileChanged watcher: ${error.message}`));
        this.watchers.push(watcher);
      } catch (error) {
        this.options.onError?.(`FileChanged watcher: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Native notifications may be coalesced or lost; only explicit matcher targets are polled.
    this.polling = setInterval(() => { void this.scan(targets, generation); }, this.options.pollIntervalMs ?? 500);
    this.polling.unref();
  }

  private async readVersion(path: string): Promise<string | undefined | null> {
    try { const version = await fileVersion(path); this.readErrors.delete(path); return version; }
    catch (error) { if (!this.readErrors.has(path)) { this.readErrors.add(path); this.options.onError?.(`FileChanged stat: ${error instanceof Error ? error.message : String(error)}`); } return null; }
  }

  private async scan(targets: string[], generation: number): Promise<void> {
    if (this.scanning || generation !== this.generation) return;
    this.scanning = true;
    try {
      for (const path of targets) {
        const version = await this.readVersion(path);
        if (generation !== this.generation) return;
        if (version === null) continue;
        if (!this.versions.has(path)) { this.versions.set(path, version); this.existence.set(path, version !== undefined); continue; }
        if (version !== this.versions.get(path) && !this.timers.has(path)) this.schedule(path);
      }
    } catch (error) { this.options.onError?.(`FileChanged scan: ${error instanceof Error ? error.message : String(error)}`); }
    finally { this.scanning = false; }
  }

  private schedule(path: string): void {
    const current = this.timers.get(path);
    if (current) clearTimeout(current);
    const timer = setTimeout(() => {
      this.timers.delete(path);
      void this.emit(path, this.generation).catch(error => this.options.onError?.(`FileChanged hook: ${error instanceof Error ? error.message : String(error)}`));
    }, 150);
    timer.unref();
    this.timers.set(path, timer);
  }

  private async emit(path: string, generation: number): Promise<void> {
    const wasPresent = this.existence.get(path) ?? false;
    const version = await this.readVersion(path);
    if (generation !== this.generation || version === null || version === this.versions.get(path)) return;
    if (!this.versions.has(path)) { this.versions.set(path, version); this.existence.set(path, version !== undefined); return; }
    const present = version !== undefined;
    this.versions.set(path, version); this.existence.set(path, present);
    const event: FileChangedEvent = present ? (wasPresent ? "change" : "add") : "unlink";
    await this.options.onChange(path, event).catch((error) => {
      this.options.onError?.(`FileChanged hook: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

async function fileVersion(path: string): Promise<string | undefined> {
  const info = await stat(path, { bigint: true }).catch(error => { if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined; throw error; });
  return info ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` : undefined;
}
