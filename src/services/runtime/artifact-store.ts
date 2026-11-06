import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { encodeJson } from "./json";

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
      // Node cannot fsync directories on Windows; the artifact file was flushed before rename.
      if (process.platform !== "win32") {
        const directory = await open(this.root, "r"); try { await directory.sync(); } finally { await directory.close(); }
      }
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
