import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type FileChangedEvent = "change" | "add" | "unlink";

export class HookFileWatcher {
  private watchers: FSWatcher[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private existence = new Map<string, boolean>();

  constructor(private options: {
    cwd: string;
    matchers: string[];
    onChange(path: string, event: FileChangedEvent): Promise<void>;
    onError?(message: string): void;
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
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async restart(): Promise<void> {
    this.close();
    this.existence.clear();
    const targets = [...new Set(this.options.matchers.flatMap((matcher) =>
      matcher.split("|").map((value) => value.trim()).filter(Boolean)
    ).map((path) => resolve(this.options.cwd, path)))];
    const byDirectory = new Map<string, Set<string>>();
    for (const target of targets) {
      this.existence.set(target, await exists(target));
      const directory = dirname(target);
      const group = byDirectory.get(directory) ?? new Set<string>();
      group.add(target);
      byDirectory.set(directory, group);
    }
    for (const [directory, group] of byDirectory) {
      try {
        const watcher = watch(directory, { persistent: false }, (_event, filename) => {
          if (!filename) return;
          const changed = resolve(directory, filename.toString());
          if (group.has(changed)) this.schedule(changed);
        });
        watcher.on("error", (error) => this.options.onError?.(`FileChanged watcher: ${error.message}`));
        this.watchers.push(watcher);
      } catch (error) {
        this.options.onError?.(`FileChanged watcher: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private schedule(path: string): void {
    const current = this.timers.get(path);
    if (current) clearTimeout(current);
    const timer = setTimeout(() => {
      this.timers.delete(path);
      void this.emit(path);
    }, 150);
    timer.unref();
    this.timers.set(path, timer);
  }

  private async emit(path: string): Promise<void> {
    const wasPresent = this.existence.get(path) ?? false;
    const present = await exists(path);
    this.existence.set(path, present);
    const event: FileChangedEvent = present ? (wasPresent ? "change" : "add") : "unlink";
    await this.options.onChange(path, event).catch((error) => {
      this.options.onError?.(`FileChanged hook: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}
