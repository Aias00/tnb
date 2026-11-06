import { createHash } from "node:crypto";
import type { FileChangeEvidence } from "../../core/tool";
/** Called only after a successful atomic write, using the exact values inside its mutation lock. */
export function fileChangeEvidence(path: string, before: string | undefined, after: string): FileChangeEvidence {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const truncated = Buffer.byteLength(before ?? "") + Buffer.byteLength(after) > 32 * 1024;
  return { path, beforeHash: before === undefined ? null : hash(before), afterHash: hash(after), truncated,
    ...(truncated ? {} : { before: before ?? null, after }) };
}
