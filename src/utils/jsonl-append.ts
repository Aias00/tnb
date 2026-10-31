import { randomUUID } from "node:crypto";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock } from "./lockfile";

/** Append only on a record boundary. Preserve an interrupted tail before trimming it. */
export async function appendJsonl(filePath: string, records: readonly unknown[], options: {
  sync?: boolean;
  validate?(file: FileHandle): Promise<void>;
} = {}): Promise<void> {
  if (!records.length) return;
  const payload = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await withFileLock(filePath, async () => {
    const file = await open(filePath, "a+", 0o600);
    try {
      await options.validate?.(file);
      await finishTail(file, filePath);
      await file.writeFile(payload);
      if (options.sync) await file.sync();
    } finally { await file.close(); }
  });
}

async function finishTail(file: FileHandle, filePath: string): Promise<void> {
  const { size } = await file.stat();
  if (!size) return;
  const last = Buffer.alloc(1); await file.read(last, 0, 1, size - 1);
  if (last[0] === 0x0a) return;
  const parts: Buffer[] = [];
  let position = size;
  let boundary = 0;
  while (position > 0) {
    const start = Math.max(0, position - 4096);
    const chunk = Buffer.alloc(position - start);
    await readExactly(file, chunk, start);
    const newline = chunk.lastIndexOf(0x0a);
    if (newline !== -1) {
      boundary = start + newline + 1;
      parts.unshift(chunk.subarray(newline + 1));
      break;
    }
    parts.unshift(chunk); position = start;
  }
  const tail = Buffer.concat(parts);
  let complete = !tail.toString("utf8").trim();
  if (!complete) { try { JSON.parse(tail.toString("utf8").trim()); complete = true; } catch { /* Torn record. */ } }
  if (complete) { await file.writeFile("\n"); return; }
  const backup = await open(`${filePath}.torn-${randomUUID()}`, "wx", 0o600);
  try { await backup.writeFile(tail); await backup.sync(); }
  finally { await backup.close(); }
  await file.truncate(boundary);
}

export async function readExactly(file: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let read = 0;
  while (read < buffer.length) {
    const { bytesRead } = await file.read(buffer, read, buffer.length - read, position + read);
    if (!bytesRead) throw new Error("JSONL file changed while reading; stop before appending");
    read += bytesRead;
  }
}
