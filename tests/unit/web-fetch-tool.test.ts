import { describe, expect, test } from "bun:test";

import { createWebFetchTool, WEB_FETCH_DEFAULTS } from "../../src/tools/web-fetch";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 as const }];

describe("web fetch tool", () => {
  test("uses the established web resource limits", () => {
    expect(WEB_FETCH_DEFAULTS).toEqual({
      maxBytes: 10 * 1024 * 1024,
      maxOutputChars: 100_000,
      maxRedirects: 10,
      timeoutMs: 60_000,
      cacheTtlMs: 15 * 60_000,
      maxCacheEntries: 32,
    });
  });

  test("converts HTML to compact Markdown and caches successful responses", async () => {
    let requests = 0;
    const tool = createWebFetchTool({
      lookup: publicLookup,
      fetch: async () => {
        requests += 1;
        return new Response("<html><script>bad()</script><h1>Guide &amp; API</h1><p>Read <a href='/docs'>docs</a>.</p><ul><li>One</li><li>Two</li></ul></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });

    const input = tool.validate({ url: "https://example.com/guide" });
    const first = await tool.execute(input, new AbortController().signal);
    const second = await tool.execute(input, new AbortController().signal);
    expect(first).toContain("# Guide & API");
    expect(first).toContain("Read [docs](/docs).");
    expect(first).toContain("- One\n- Two");
    expect(first).not.toContain("bad()");
    expect(second).toBe(first);
    expect(requests).toBe(1);
  });

  test("fetches bounded public text content", async () => {
    const requests: string[] = [];
    const tool = createWebFetchTool({
      lookup: publicLookup,
      fetch: async (input) => {
        requests.push(String(input));
        return new Response("hello web", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    });

    const output = await tool.execute(
      tool.validate({ url: "https://example.com/guide" }),
      new AbortController().signal,
    );

    expect(requests).toEqual(["https://example.com/guide"]);
    expect(output).toContain("URL: https://example.com/guide");
    expect(output).toContain("Content-Type: text/plain; charset=utf-8");
    expect(output).toEndWith("hello web");
  });

  test("rejects unsupported protocols and embedded credentials", () => {
    const tool = createWebFetchTool({ lookup: publicLookup });

    expect(() => tool.validate({ url: "file:///etc/passwd" })).toThrow("http or https");
    expect(() => tool.validate({ url: "https://user:secret@example.com" })).toThrow(
      "embedded credentials",
    );
  });

  test("blocks local hostnames and private literal addresses before fetching", async () => {
    let calls = 0;
    const tool = createWebFetchTool({
      lookup: publicLookup,
      fetch: async () => {
        calls += 1;
        return new Response("unreachable");
      },
    });

    for (const url of ["http://localhost/admin", "http://127.0.0.1/admin", "http://[::1]/admin"]) {
      await expect(
        tool.execute(tool.validate({ url }), new AbortController().signal),
      ).rejects.toThrow("public internet host");
    }
    expect(calls).toBe(0);
  });

  test("blocks hostnames that resolve to a private address", async () => {
    const tool = createWebFetchTool({
      lookup: async () => [{ address: "10.0.0.8", family: 4 }],
      fetch: async () => new Response("unreachable"),
    });

    await expect(
      tool.execute(
        tool.validate({ url: "https://internal.example.com" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("resolved to a non-public address");
  });

  test("revalidates redirects and blocks a redirect to a private address", async () => {
    const requests: string[] = [];
    const tool = createWebFetchTool({
      lookup: publicLookup,
      fetch: async (input) => {
        requests.push(String(input));
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
      },
    });

    await expect(
      tool.execute(
        tool.validate({ url: "https://example.com/start" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("public internet host");
    expect(requests).toEqual(["https://example.com/start"]);
  });

  test("returns a cross-host redirect for explicit follow-up", async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup,
      fetch: async () =>
        new Response(null, { status: 302, headers: { location: "https://docs.example.net/page" } }),
    });

    expect(
      await tool.execute(
        tool.validate({ url: "https://example.com/start" }),
        new AbortController().signal,
      ),
    ).toBe("Redirect requires a new web_fetch call: https://docs.example.net/page");
  });

  test("rejects responses larger than the configured byte limit", async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup,
      maxBytes: 4,
      fetch: async () =>
        new Response("hello", { headers: { "content-type": "text/plain" } }),
    });

    await expect(
      tool.execute(
        tool.validate({ url: "https://example.com/large" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("exceeds the 4 byte limit");
  });

  test("accepts a response declared above one MiB under the default limit", async () => {
    const tool = createWebFetchTool({
      lookup: publicLookup,
      fetch: async () =>
        new Response("content", {
          headers: {
            "content-type": "text/plain",
            "content-length": String(2 * 1024 * 1024),
          },
        }),
    });

    expect(
      await tool.execute(
        tool.validate({ url: "https://example.com/resource" }),
        new AbortController().signal,
      ),
    ).toEndWith("content");
  });

  test("allows ten same-host redirects before enforcing the default limit", async () => {
    let requests = 0;
    const tool = createWebFetchTool({
      lookup: publicLookup,
      fetch: async () => {
        requests += 1;
        return new Response(null, { status: 302, headers: { location: `/redirect-${requests}` } });
      },
    });

    await expect(
      tool.execute(
        tool.validate({ url: "https://example.com/start" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("exceeded 10 redirects");
    expect(requests).toBe(11);
  });
});
