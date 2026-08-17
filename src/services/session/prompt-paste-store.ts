import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { StoredPastedContent } from "../../core/prompt-input";
import { withFileLock } from "../../utils/lockfile";

const INLINE_LIMIT = 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export class PromptPasteStore {
  readonly directory: string;

  constructor(projectDirectory: string) {
    this.directory = join(projectDirectory, "prompt-pastes");
  }

  async storeText(id: number, content: string): Promise<Extract<StoredPastedContent, { type: "text" }>> {
    if (content.length <= INLINE_LIMIT) return { id, type: "text", content };
    const contentHash = createHash("sha256").update(content).digest("hex");
    const path = this.pathForHash(contentHash);
    await withFileLock(path, async () => {
      await mkdir(this.directory, { recursive: true });
      try {
        await readFile(path);
        return;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    });
    return { id, type: "text", contentHash };
  }

  async resolveText(content: Extract<StoredPastedContent, { type: "text" }>): Promise<string | undefined> {
    if (content.content !== undefined) return content.content;
    if (!content.contentHash) return undefined;
    const path = this.pathForHash(content.contentHash);
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  private pathForHash(hash: string): string {
    if (!HASH_PATTERN.test(hash)) throw new Error(`Invalid prompt paste hash: ${hash}`);
    return join(this.directory, hash);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
