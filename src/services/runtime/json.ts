import { createHash } from "node:crypto";

/** Stable JSON command identity; object key order has no semantic meaning. */
export function encodeJson(value: unknown, maxBytes = 256 * 1024): string {
  const ancestors = new Set<object>();
  function normalize(item: unknown, depth: number): unknown {
    if (depth > 32) throw new Error("Runtime JSON nesting limit exceeded");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || !item) throw new Error("Runtime payload must contain JSON values");
    if (ancestors.has(item)) throw new Error("Runtime payload contains a cycle");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error("Runtime payload requires plain JSON objects");
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.map((entry) => normalize(entry, depth + 1));
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        const entry = (item as Record<string, unknown>)[key];
        if (entry !== undefined) result[key] = normalize(entry, depth + 1);
      }
      return result;
    } finally { ancestors.delete(item); }
  }
  const encoded = JSON.stringify(normalize(value, 0));
  if (Buffer.byteLength(encoded) > maxBytes) throw new Error("Runtime JSON payload exceeds its byte limit");
  return encoded;
}

export function digestJson(value: unknown): string {
  return createHash("sha256").update(encodeJson(value)).digest("hex");
}

export function text(value: string, name: string, maximum = 4096): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum) throw new Error(`Invalid ${name}`);
  return value;
}

export function integer(value: number, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
