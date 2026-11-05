import { createHash } from "node:crypto";
import { readdir, readlink, lstat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { digestJson } from "../../services/runtime/json";

/** Content manifest includes dirty/untracked inputs; generated dependency/build directories are excluded explicitly. */
export async function workspaceManifest(root: string): Promise<{ digest: string; files: Record<string, string> }> {
  const files: Record<string, string> = {};
  let total = 0; let entries = 0;
  async function walk(directory: string, depth = 0): Promise<void> {
    if (depth > 64) throw new Error("Workspace manifest directory depth exceeded");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "build", "coverage", ".tnb"].includes(entry.name)) continue;
      const path = join(directory, entry.name); const key = relative(root, path);
      if (++entries > 20000) throw new Error("Workspace manifest file limit exceeded");
      if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
      if (entry.isSymbolicLink()) { files[key] = digestJson({ symlink: await readlink(path) }); continue; }
      if (!entry.isFile()) continue;
      const before = await lstat(path);
      if ((total += before.size) > 256 * 1024 * 1024 || before.size > 16 * 1024 * 1024) throw new Error("Workspace manifest byte limit exceeded");
      const bytes = await readFile(path); const after = await lstat(path);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Workspace changed while capturing input");
      files[key] = digestJson({ content: createHash("sha256").update(bytes).digest("hex"), mode: before.mode & 0o777 });
    }
  }
  await walk(root);
  return { digest: digestJson(files), files };
}
