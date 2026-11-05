import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, readlink, lstat, rename, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { digestJson, encodeJson } from "./json";

export class RuntimeArtifacts {
  constructor(readonly root: string) {}
  async put(value: unknown): Promise<string> {
    const data = encodeJson(value, 1024 * 1024);
    const hash = createHash("sha256").update(data).digest("hex");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = join(this.root, `${hash}.json`);
    const temporary = join(this.root, `${hash}.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(data); await file.sync(); }
    finally { await file.close(); }
    try {
      await rename(temporary, target);
      const directory = await open(this.root, "r"); try { await directory.sync(); } finally { await directory.close(); }
    }
    finally { await unlink(temporary).catch(() => undefined); }
    return hash;
  }
  async get<T>(hash: string): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid artifact reference");
    const data = await readFile(join(this.root, `${hash}.json`));
    if (data.length > 1024 * 1024 || createHash("sha256").update(data).digest("hex") !== hash) throw new Error("Artifact integrity failure");
    return JSON.parse(data.toString("utf8"));
  }
}

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
