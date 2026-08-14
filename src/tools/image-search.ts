import { defineTool } from "../core/tool";
import { IMAGE_SEARCH_TOOL_PROMPT } from "../constants/tool-prompts";
import { ProviderHttpError } from "../providers/retry";

type ImageSearchInput = {
  query: string;
  count?: number;
  safesearch?: "strict" | "off";
  country?: string;
  search_lang?: string;
};

export type ImageSearchOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;

export function createImageSearchTool(options: ImageSearchOptions) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");

  return defineTool<ImageSearchInput>({
    name: "image_search",
    description: IMAGE_SEARCH_TOOL_PROMPT,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 400,
          description: "Image search query, limited to 400 characters and 50 words.",
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Number of results. Brave defaults to 50 and permits up to 200.",
        },
        safesearch: {
          type: "string",
          enum: ["strict", "off"],
          description: "Adult-content filtering. Defaults to strict.",
        },
        country: {
          type: "string",
          description: "Optional two-letter country code or ALL.",
        },
        search_lang: {
          type: "string",
          description: "Optional search language code.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    access: "network",
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    permissionRuleContent: ({ query }) => query,
    validate(input) {
      const value = requireObject(input);
      const query = nonEmptyString(value.query, "image_search query");
      if (query.length > 400 || query.split(/\s+/).length > 50) {
        throw new Error("image_search query exceeds the provider's 400 character or 50 word limit");
      }
      const count = value.count === undefined ? undefined : boundedInteger(value.count, 1, 200, "count");
      const safesearch = optionalEnum(value.safesearch, ["strict", "off"] as const, "safesearch");
      const country = optionalCode(value.country, "country", 2, true);
      const searchLang = optionalCode(value.search_lang, "search_lang", 2, false);
      return {
        query,
        ...(count === undefined ? {} : { count }),
        ...(safesearch === undefined ? {} : { safesearch }),
        ...(country === undefined ? {} : { country }),
        ...(searchLang === undefined ? {} : { search_lang: searchLang }),
      };
    },
    async execute(input, signal) {
      const url = new URL(options.baseUrl ?? "https://api.search.brave.com/res/v1/images/search");
      url.searchParams.set("q", input.query);
      if (input.count !== undefined) url.searchParams.set("count", String(input.count));
      if (input.safesearch !== undefined) url.searchParams.set("safesearch", input.safesearch);
      if (input.country !== undefined) url.searchParams.set("country", input.country);
      if (input.search_lang !== undefined) url.searchParams.set("search_lang", input.search_lang);
      const response = await fetcher(url, {
        headers: {
          accept: "application/json",
          "x-subscription-token": options.apiKey,
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (!response.ok) {
        throw new ProviderHttpError(
          response.status,
          `Brave Image Search request failed (${response.status}): ${await response.text()}`,
          response.headers,
        );
      }
      const data = (await response.json()) as BraveImageSearchResponse;
      if (!data.results?.length) return "No image search results found";
      return data.results.map(renderResult).join("\n\n");
    },
  });
}

function renderResult(result: BraveImageResult, index: number): string {
  const originalUrl = result.properties?.url ?? result.url;
  const dimensions = result.properties?.width && result.properties.height
    ? `${result.properties.width}x${result.properties.height}`
    : undefined;
  return [
    `${index + 1}. ${plainText(result.title || "Untitled image")}`,
    `   Image: ${originalUrl}`,
    result.thumbnail?.src ? `   Thumbnail: ${result.thumbnail.src}` : undefined,
    result.source ? `   Source: ${result.source}` : undefined,
    dimensions ? `   Dimensions: ${dimensions}` : undefined,
  ].filter(Boolean).join("\n");
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("image_search input must be an object");
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function boundedInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`image_search ${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`image_search ${name} must be a positive integer`);
  return value;
}

function optionalEnum<T extends string>(value: unknown, choices: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new Error(`image_search ${name} must be one of: ${choices.join(", ")}`);
  }
  return value as T;
}

function optionalCode(value: unknown, name: string, minimumLength: number, allowAll: boolean): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`image_search ${name} must be a string`);
  const code = value.trim();
  if ((allowAll && code.toUpperCase() === "ALL") || /^[A-Za-z]{2,10}$/.test(code) && code.length >= minimumLength) {
    return allowAll ? code.toUpperCase() : code.toLowerCase();
  }
  throw new Error(`image_search ${name} is invalid`);
}

function plainText(value: string): string {
  return value.replace(/<[^>]*>/g, "").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").trim();
}

type BraveImageResult = {
  title?: string;
  url?: string;
  source?: string;
  thumbnail?: { src?: string };
  properties?: { url?: string; width?: number; height?: number };
};

type BraveImageSearchResponse = { results?: BraveImageResult[] };
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
