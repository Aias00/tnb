import { readFile, stat } from "node:fs/promises";
import { watch, watchFile, unwatchFile, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Git metadata only; no subprocess and no periodic directory scan. */
export async function watchWorkspaceBranch(workspace: string, changed: (branch: string) => void): Promise<() => void> {
  let directory = resolve(workspace), head: string | undefined;
  for (let depth = 0; depth < 64; depth++) {
    const git = join(directory, ".git");
    try {
      const info = await stat(git);
      if (info.isDirectory()) head = join(git, "HEAD");
      else {
        const link = await readFile(git, "utf8"); const match = /^gitdir:\s*(.+)\s*$/m.exec(link);
        if (match) head = join(resolve(directory, match[1]!), "HEAD");
      }
      break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") break; }
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  if (!head) { changed(""); return () => {}; }
  let closed = false, watcher: FSWatcher | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let previous: string | undefined;
  const refresh = async () => {
    const value = await readFile(head!, "utf8").catch(() => "");
    const branch = value.startsWith("ref: refs/heads/") ? value.slice(16).trim() : value.trim() ? "detached" : "";
    if (!closed && branch !== previous) { previous = branch; changed(branch); }
  };
  // Native watchers can drop the first macOS event or a replacement HEAD event.
  // One HEAD stat per second is a fallback, never a workspace directory scan.
  const poll = () => { void refresh(); };
  watchFile(head, { persistent: false, interval: 1000 }, poll);
  try { watcher = watch(dirname(head), (_event, name) => {
    if (name && name.toString() !== "HEAD") return;
    if (timer) clearTimeout(timer); timer = setTimeout(() => { void refresh(); }, 200); timer.unref();
  }); watcher.on("error", () => { watcher?.close(); }); } catch { /* Branch information is optional. */ }
  await refresh();
  return () => { closed = true; if (timer) clearTimeout(timer); watcher?.close(); unwatchFile(head!, poll); };
}
