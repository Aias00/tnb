import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

import { defineTool } from "../core/tool";
import { WEB_FETCH_TOOL_PROMPT } from "../constants/tool-prompts";

type LookupAddress = { address: string; family: 4 | 6 };
type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>;

export type WebFetchToolOptions = {
  fetch?: FetchImplementation;
  lookup?: (hostname: string) => Promise<readonly LookupAddress[]>;
  maxBytes?: number;
  maxOutputChars?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
};

type WebFetchInput = { url: string };

export const WEB_FETCH_DEFAULTS = {
  maxBytes: 10 * 1024 * 1024,
  maxOutputChars: 100_000,
  maxRedirects: 10,
  timeoutMs: 60_000,
  cacheTtlMs: 15 * 60_000,
  maxCacheEntries: 32,
} as const;
const MAX_URL_LENGTH = 2_000;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

const nonPublicAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv6");
}

export function createWebFetchTool(options: WebFetchToolOptions = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const lookup = options.lookup ?? defaultLookup;
  const maxBytes = positiveInteger(options.maxBytes, WEB_FETCH_DEFAULTS.maxBytes, "maxBytes");
  const maxOutputChars = positiveInteger(
    options.maxOutputChars,
    WEB_FETCH_DEFAULTS.maxOutputChars,
    "maxOutputChars",
  );
  const maxRedirects = nonNegativeInteger(
    options.maxRedirects,
    WEB_FETCH_DEFAULTS.maxRedirects,
    "maxRedirects",
  );
  const timeoutMs = positiveInteger(options.timeoutMs, WEB_FETCH_DEFAULTS.timeoutMs, "timeoutMs");
  const cacheTtlMs = nonNegativeInteger(options.cacheTtlMs, WEB_FETCH_DEFAULTS.cacheTtlMs, "cacheTtlMs");
  const maxCacheEntries = positiveInteger(options.maxCacheEntries, WEB_FETCH_DEFAULTS.maxCacheEntries, "maxCacheEntries");
  const cache = new Map<string, { value: string; expiresAt: number }>();

  return defineTool<WebFetchInput>({
    name: "web_fetch",
    description: WEB_FETCH_TOOL_PROMPT,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public HTTP or HTTPS URL to fetch." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    access: "network",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permissionRuleContent: ({ url }) => url,
    validate(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("web_fetch input must be an object");
      }
      const url = (input as Record<string, unknown>).url;
      if (typeof url !== "string" || !url.trim()) {
        throw new Error("web_fetch requires a non-empty URL");
      }
      return { url: validateUrl(url).toString() };
    },
    async execute({ url }, signal) {
      const cached = cache.get(url);
      if (cached && cached.expiresAt > Date.now()) {
        cache.delete(url);
        cache.set(url, cached);
        return cached.value;
      }
      if (cached) cache.delete(url);
      const deadlineSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const value = await fetchText(
        validateUrl(url),
        { fetchImpl, lookup, maxBytes, maxOutputChars, maxRedirects },
        deadlineSignal,
      );
      if (cacheTtlMs > 0 && !value.startsWith("Redirect requires a new web_fetch call:")) {
        cache.set(url, { value, expiresAt: Date.now() + cacheTtlMs });
        while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value!);
      }
      return value;
    },
  });
}

type FetchContext = {
  fetchImpl: FetchImplementation;
  lookup: (hostname: string) => Promise<readonly LookupAddress[]>;
  maxBytes: number;
  maxOutputChars: number;
  maxRedirects: number;
};

async function fetchText(
  initialUrl: URL,
  context: FetchContext,
  signal: AbortSignal,
): Promise<string> {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; ; redirectCount += 1) {
    signal.throwIfAborted();
    await assertPublicUrl(currentUrl, context.lookup);
    const response = await context.fetchImpl(currentUrl.toString(), {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        accept: "text/markdown, text/plain, text/html, application/json, application/xml, text/xml",
        "user-agent": "tnb/0.0",
      },
    });

    if (REDIRECT_STATUS.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`HTTP ${response.status} redirect is missing a Location header`);
      const redirectedUrl = validateUrl(new URL(location, currentUrl).toString());
      await assertPublicUrl(redirectedUrl, context.lookup);
      if (!isSameHostRedirect(currentUrl, redirectedUrl)) {
        return `Redirect requires a new web_fetch call: ${redirectedUrl.toString()}`;
      }
      if (redirectCount >= context.maxRedirects) {
        throw new Error(`web_fetch exceeded ${context.maxRedirects} redirects`);
      }
      currentUrl = redirectedUrl;
      continue;
    }

    if (!response.ok) throw new Error(`web_fetch received HTTP ${response.status} ${response.statusText}`.trim());
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (!isTextContentType(contentType)) {
      throw new Error(`web_fetch does not support binary content type: ${contentType}`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > context.maxBytes) {
      throw new Error(`web_fetch response exceeds the ${context.maxBytes} byte limit`);
    }
    const bytes = await readBoundedBody(response, context.maxBytes);
    const decoded = new TextDecoder().decode(bytes);
    const content = isHtmlContentType(contentType) ? htmlToMarkdown(decoded) : decoded;
    const rendered = content.length > context.maxOutputChars
      ? `${content.slice(0, context.maxOutputChars)}\n(Content truncated at ${context.maxOutputChars} characters.)`
      : content;
    return [
      `URL: ${currentUrl.toString()}`,
      `Status: ${response.status} ${response.statusText}`.trim(),
      `Content-Type: ${contentType}`,
      "",
      rendered,
    ].join("\n");
  }
}

function validateUrl(value: string): URL {
  if (value.length > MAX_URL_LENGTH) throw new Error(`web_fetch URL exceeds ${MAX_URL_LENGTH} characters`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("web_fetch requires a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_fetch URL must use http or https");
  }
  if (url.username || url.password) throw new Error("web_fetch URL cannot contain embedded credentials");
  return url;
}

async function assertPublicUrl(
  url: URL,
  lookup: (hostname: string) => Promise<readonly LookupAddress[]>,
): Promise<void> {
  const hostname = unbracket(url.hostname).toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".lan") ||
    (!hostname.includes(".") && isIP(hostname) === 0)
  ) {
    throw new Error("web_fetch requires a public internet host");
  }

  const family = isIP(hostname);
  if (family !== 0) {
    if (isNonPublicAddress(hostname, family)) {
      throw new Error("web_fetch requires a public internet host");
    }
    return;
  }

  const addresses = await lookup(hostname);
  if (addresses.length === 0) throw new Error(`web_fetch could not resolve ${hostname}`);
  if (addresses.some(({ address, family }) => isNonPublicAddress(address, family))) {
    throw new Error(`web_fetch host ${hostname} resolved to a non-public address`);
  }
}

function isNonPublicAddress(address: string, family: number): boolean {
  return family === 4
    ? nonPublicAddresses.check(address, "ipv4")
    : nonPublicAddresses.check(address, "ipv6");
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`web_fetch response exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isSameHostRedirect(original: URL, redirected: URL): boolean {
  const stripWww = (hostname: string) => hostname.toLowerCase().replace(/^www\./, "");
  if (stripWww(original.hostname) !== stripWww(redirected.hostname)) return false;
  if (original.port !== redirected.port) return false;
  return original.protocol === redirected.protocol || (original.protocol === "http:" && redirected.protocol === "https:");
}

function isTextContentType(value: string): boolean {
  const type = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") ||
    type === "application/xml" || type.endsWith("+xml");
}

function isHtmlContentType(value: string): boolean {
  return value.split(";", 1)[0]?.trim().toLowerCase() === "text/html";
}

export function htmlToMarkdown(html: string): string {
  let value = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*hr\s*\/?>/gi, "\n---\n")
    .replace(/<\s*(h[1-6])\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, (_match, tag: string, body: string) =>
      `\n${"#".repeat(Number(tag.slice(1)))} ${stripTags(body).trim()}\n`)
    .replace(/<\s*a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/\s*a\s*>/gi,
      (_match, double: string, single: string, bare: string, body: string) => {
        const label = stripTags(body).trim();
        const href = decodeHtmlEntities(double || single || bare || "");
        return label && href ? `[${label}](${href})` : label;
      })
    .replace(/<\s*li\b[^>]*>([\s\S]*?)<\/\s*li\s*>/gi, (_match, body: string) => `\n- ${stripTags(body).trim()}`)
    .replace(/<\s*(?:p|div|section|article|header|footer|main|nav|ul|ol|pre|blockquote|table|tr)\b[^>]*>/gi, "\n")
    .replace(/<\/\s*(?:p|div|section|article|header|footer|main|nav|ul|ol|pre|blockquote|table|tr)\s*>/gi, "\n")
    .replace(/<\s*(?:strong|b)\b[^>]*>([\s\S]*?)<\/\s*(?:strong|b)\s*>/gi, "**$1**")
    .replace(/<\s*(?:em|i)\b[^>]*>([\s\S]*?)<\/\s*(?:em|i)\s*>/gi, "*$1*")
    .replace(/<\s*code\b[^>]*>([\s\S]*?)<\/\s*code\s*>/gi, "`$1`")
    .replace(/<[^>]+>/g, "");
  value = decodeHtmlEntities(value)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return value;
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ""));
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
    const hexadecimal = entity[1]?.toLowerCase() === "x";
    const point = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

async function defaultLookup(hostname: string): Promise<readonly LookupAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
}

function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function positiveInteger(value: number | undefined, defaultValue: number, name: string): number {
  const result = value ?? defaultValue;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${name} must be a positive integer`);
  return result;
}

function nonNegativeInteger(value: number | undefined, defaultValue: number, name: string): number {
  const result = value ?? defaultValue;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${name} must be a non-negative integer`);
  return result;
}
