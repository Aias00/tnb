import { createHash, randomUUID } from "node:crypto";
import { chmod, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { withFileLock } from "./lockfile";

/** Coordinate shared workspaces across agents and cooperating CLI processes. */
export async function withFileMutation<T>(target: string, operation: () => Promise<T>): Promise<T> {
  let parent = resolve(target);
  let canonical: string;
  for (;;) {
    try {
      canonical = resolve(await realpath(parent), relative(parent, target));
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
  const identity = createHash("sha256").update(canonical).digest("hex");
  const directory = join(tmpdir(), `tnb-file-mutations-${process.platform === "win32" ? "local" : process.getuid?.() ?? "local"}`);
  return withFileLock(join(directory, identity), operation);
}

/** Atomic visibility for a single file; this is not a multi-file or power-loss transaction. */
export async function atomicWriteText(target: string, content: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const mode = await stat(target).then((value) => value.mode & 0o777).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  const temporary = join(dirname(target), `.tnb-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: mode ?? 0o666, flag: "wx", signal });
    if (mode !== undefined) await chmod(temporary, mode);
    signal.throwIfAborted();
    await rename(temporary, target);
    // After rename the effect is committed. Cancellation cannot turn it into "not written".
  } finally {
    await unlink(temporary).catch((error) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    });
  }
}
