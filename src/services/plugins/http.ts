import type { LookupFunction } from "node:net";
// Bun 1.3's bare "undici" specifier is a compatibility shim. Use the pinned package.
import { Client } from "undici/index.js";

const localhostLookup: LookupFunction = (_host, options, done) => options.all
  ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4);

/** Explicit client owns a direct TCP/TLS connection; environment proxies and global dispatchers do not select it. */
export async function requestPluginHttp(url: URL, body: string, maxBytes: number, signal: AbortSignal): Promise<{ status: number; text: string }> {
  signal.throwIfAborted();
  const client = new Client(url.origin, { pipelining: 0, maxHeaderSize: 16 * 1024,
    connect: { rejectUnauthorized: true, ...(url.hostname === "localhost" ? { lookup: localhostLookup } : {}) },
    ...(url.hostname === "localhost" ? { autoSelectFamily: false } : {}) });
  const abort = () => { void client.destroy().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const response = await client.request({ path: url.pathname + url.search, method: "POST", signal,
      headers: { "content-type": "application/json", "accept-encoding": "identity" }, body });
    if (response.statusCode >= 300 && response.statusCode < 400) throw new Error(`Plugin tool HTTP ${response.statusCode}: redirects are not allowed; review the configured endpoint`);
    if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") throw new Error("Plugin tool HTTP compressed responses are not supported");
    if (Number(response.headers["content-length"]) > maxBytes) throw new Error(`Plugin tool HTTP response exceeds ${maxBytes} byte limit`);
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > maxBytes) throw new Error(`Plugin tool HTTP response exceeds ${maxBytes} byte limit`);
      chunks.push(Buffer.from(chunk));
    }
    signal.throwIfAborted();
    return { status: response.statusCode, text: Buffer.concat(chunks, size).toString("utf8") };
  } finally { signal.removeEventListener("abort", abort); await client.destroy(); }
}
