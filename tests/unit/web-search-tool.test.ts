import { describe, expect, test } from "bun:test";

import {
  WEB_SEARCH_DEFAULTS,
  createWebSearchTool,
} from "../../src/tools/web-search";

describe("web search tool", () => {
  test("uses the established result and output limits", () => {
    expect(WEB_SEARCH_DEFAULTS).toEqual({
      maxResults: 10,
      maxOutputChars: 100_000,
      timeoutMs: 60_000,
    });
  });

  test("queries the official Brave endpoint and formats citable results", async () => {
    let request: Request | undefined;
    const tool = createWebSearchTool({
      apiKey: "search-key",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          web: {
            results: [
              {
                title: "Example result",
                url: "https://example.com/article",
                description: "An <strong>important</strong> result.",
              },
            ],
          },
        });
      },
    });

    const input = tool.validate({ query: "coding agents" });
    const output = await tool.execute(input, new AbortController().signal);

    expect(request?.url).toBe(
      "https://api.search.brave.com/res/v1/web/search?q=coding+agents&count=10",
    );
    expect(request?.headers.get("x-subscription-token")).toBe("search-key");
    expect(output).toContain("[Example result](https://example.com/article)");
    expect(output).toContain("An important result.");
  });

  test("applies allowed and blocked domain filters", async () => {
    const tool = createWebSearchTool({
      apiKey: "search-key",
      fetch: async () =>
        Response.json({
          web: {
            results: [
              { title: "Allowed", url: "https://docs.example.com/a", description: "keep" },
              { title: "Blocked", url: "https://blog.example.com/b", description: "drop" },
              { title: "Other", url: "https://other.test/c", description: "drop" },
            ],
          },
        }),
    });

    const allowedOutput = await tool.execute(
      tool.validate({
        query: "docs",
        allowed_domains: ["docs.example.com"],
      }),
      new AbortController().signal,
    );
    const blockedOutput = await tool.execute(
      tool.validate({ query: "docs", blocked_domains: ["blog.example.com"] }),
      new AbortController().signal,
    );

    expect(allowedOutput).toContain("Allowed");
    expect(allowedOutput).not.toContain("Blocked");
    expect(allowedOutput).not.toContain("Other");
    expect(blockedOutput).toContain("Allowed");
    expect(blockedOutput).not.toContain("Blocked");
    expect(blockedOutput).toContain("Other");
  });

  test("rejects invalid queries and conflicting domain filters", () => {
    const tool = createWebSearchTool({ apiKey: "search-key" });
    expect(() => tool.validate({ query: "" })).toThrow("query");
    expect(() =>
      tool.validate({
        query: "docs",
        allowed_domains: ["example.com"],
        blocked_domains: ["other.test"],
      }),
    ).toThrow("cannot specify both");
  });
});
