import { open, stat } from "node:fs/promises";

export const DEFAULT_TEXT_READ_BYTES = 64 * 1024;
export const MAX_TEXT_READ_BYTES = 1024 * 1024;

/** Byte pages avoid scanning an arbitrarily large prefix for a line offset. */
export async function readTextPage(target: string, offset: number, limit: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!(await stat(target)).isFile()) throw new Error("read requires a regular file");
  const file = await open(target, "r");
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error("read requires a regular file");
    // Look ahead across one UTF-8 character; always return a usable continuation.
    const buffer = Buffer.alloc(Math.min(limit + 4, Math.max(0, before.size - offset)));
    let length = 0;
    while (length < buffer.length) {
      signal.throwIfAborted();
      const result = await file.read(buffer, length, buffer.length - length, offset + length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    signal.throwIfAborted();
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("File changed while reading; read it again");
    }
    let end = Math.min(limit, length);
    while (end < length && (buffer[end]! & 0xc0) === 0x80) end++;
    const bytes = buffer.subarray(0, end);
    if (bytes.includes(0)) throw new Error("Unsupported binary file; read requires UTF-8 text");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error("Invalid UTF-8 text or offset inside a UTF-8 character; use the returned next offset"); }
    return { content, nextOffset: offset + end, size: after.size, timestamp: Math.floor(after.mtimeMs),
      complete: offset === 0 && end === after.size };
  } finally {
    await file.close();
  }
}
