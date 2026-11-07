import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Bound regular-file reads, including concurrent growth; never follow symlinks or block on FIFOs. */
export async function readJsonDocument(path: string, label = "Document", maximum = 65536): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error(`${label} must be a regular JSON file of at most ${maximum / 1024} KiB`);
    const buffer = Buffer.alloc(maximum + 1); let size = 0;
    while (size < buffer.length) { const { bytesRead } = await file.read(buffer, size, buffer.length - size, size); if (!bytesRead) break; size += bytesRead; }
    if (size > maximum) throw new Error(`${label} exceeds ${maximum / 1024} KiB`);
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))); }
    catch { throw new Error(`${label} must contain valid UTF-8 JSON`); }
  } finally { await file.close(); }
}
