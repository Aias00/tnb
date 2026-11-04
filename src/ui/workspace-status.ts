import { readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
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
  const refresh = async () => {
    const value = await readFile(head!, "utf8").catch(() => "");
    if (!closed) changed(value.startsWith("ref: refs/heads/") ? value.slice(16).trim() : value.trim() ? "detached" : "");
  };
  await refresh();
  try { watcher = watch(dirname(head), (_event, name) => {
    if (name && name.toString() !== "HEAD") return;
    if (timer) clearTimeout(timer); timer = setTimeout(() => { void refresh(); }, 200); timer.unref();
  }); watcher.on("error", () => { watcher?.close(); }); } catch { /* Branch information is optional. */ }
  return () => { closed = true; if (timer) clearTimeout(timer); watcher?.close(); };
}
