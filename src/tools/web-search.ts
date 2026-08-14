import { defineTool } from "../core/tool";
import { WEB_SEARCH_TOOL_PROMPT } from "../constants/tool-prompts";
import { ProviderHttpError } from "../providers/retry";

export const WEB_SEARCH_DEFAULTS = {
  maxResults: 10,
  maxOutputChars: 100_000,
  timeoutMs: 60_000,
} as const;

type WebSearchInput = {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
};

export type WebSearchOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  maxResults?: number;
  maxOutputChars?: number;
  timeoutMs?: number;
};

export function createWebSearchTool(options: WebSearchOptions) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const maxResults = positiveInteger(options.maxResults, WEB_SEARCH_DEFAULTS.maxResults, 20);
  const maxOutputChars = positiveInteger(
    options.maxOutputChars,
    WEB_SEARCH_DEFAULTS.maxOutputChars,
  );
  const timeoutMs = positiveInteger(options.timeoutMs, WEB_SEARCH_DEFAULTS.timeoutMs);

  return defineTool<WebSearchInput>({
    name: "web_search",
    description: WEB_SEARCH_TOOL_PROMPT,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 2,
          maxLength: 400,
          description: "Search query, limited to 400 characters and 50 words.",
        },
        allowed_domains: {
          type: "array",
          items: { type: "string" },
          description: "Optional domains to include. Cannot be combined with blocked_domains.",
        },
        blocked_domains: {
          type: "array",
          items: { type: "string" },
          description: "Optional domains to exclude. Cannot be combined with allowed_domains.",
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
      if (typeof value.query !== "string" || value.query.trim().length < 2) {
        throw new Error("web_search query must contain at least two characters");
      }
      const query = value.query.trim();
      if (query.length > 400 || query.split(/\s+/).length > 50) {
        throw new Error("web_search query exceeds the 400 character or 50 word limit");
      }
      const allowedDomains = optionalDomains(value.allowed_domains, "allowed_domains");
      const blockedDomains = optionalDomains(value.blocked_domains, "blocked_domains");
      if (allowedDomains?.length && blockedDomains?.length) {
        throw new Error("web_search cannot specify both allowed_domains and blocked_domains");
      }
      return {
        query,
        ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
        ...(blockedDomains ? { blocked_domains: blockedDomains } : {}),
      };
    },
    async execute(input, signal) {
      const url = new URL(
        options.baseUrl ?? "https://api.search.brave.com/res/v1/web/search",
      );
      url.searchParams.set("q", input.query);
      url.searchParams.set("count", String(maxResults));
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
          `Brave Search request failed (${response.status}): ${await response.text()}`,
          response.headers,
        );
      }
      const data = (await response.json()) as BraveSearchResponse;
      const results = (data.web?.results ?? []).filter((result) =>
        domainAllowed(result.url, input.allowed_domains, input.blocked_domains),
      );
      const output = results.length
        ? results
            .map(
              (result, index) =>
                `${index + 1}. [${plainText(result.title)}](${result.url})\n   ${plainText(result.description ?? "")}`.trimEnd(),
            )
            .join("\n\n")
        : "No web search results found";
      return output.length <= maxOutputChars
        ? output
        : `${output.slice(0, maxOutputChars)}\n[Search results truncated]`;
    },
  });
}

function domainAllowed(
  value: string,
  allowed: string[] | undefined,
  blocked: string[] | undefined,
): boolean {
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (allowed?.length && !allowed.some((domain) => matchesDomain(hostname, domain))) return false;
  if (blocked?.some((domain) => matchesDomain(hostname, domain))) return false;
  return true;
}

function matchesDomain(hostname: string, domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function optionalDomains(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`web_search ${field} must be an array of domains`);
  }
  return value.map((item) => item.trim().toLowerCase());
}

function plainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .trim();
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("web_search input must be an object");
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: number | undefined, defaultValue: number, maximum?: number): number {
  const result = value ?? defaultValue;
  if (!Number.isSafeInteger(result) || result <= 0 || (maximum !== undefined && result > maximum)) {
    throw new Error("web_search limits must be positive integers within the provider maximum");
  }
  return result;
}

type BraveSearchResponse = {
  web?: {
    results?: Array<{ title: string; url: string; description?: string }>;
  };
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
