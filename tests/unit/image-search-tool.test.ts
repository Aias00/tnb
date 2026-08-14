import { describe, expect, test } from "bun:test";

import { createImageSearchTool } from "../../src/tools/image-search";

describe("image_search tool", () => {
  test("uses Brave's image endpoint and renders source metadata", async () => {
    let requested: URL | undefined;
    const tool = createImageSearchTool({
      apiKey: "search-key",
      fetch: async (input, init) => {
        requested = new URL(String(input));
        expect(new Headers(init?.headers).get("x-subscription-token")).toBe("search-key");
        return Response.json({
          results: [{
            title: "<b>Mountain</b> &amp; lake",
            url: "https://example.com/page",
            source: "example.com",
            thumbnail: { src: "https://thumb.example/image.jpg" },
            properties: {
              url: "https://cdn.example/image.jpg",
              width: 1600,
              height: 900,
            },
          }],
        });
      },
    });

    const output = await tool.execute(tool.validate({
      query: "mountain lake",
      count: 12,
      safesearch: "strict",
      country: "us",
      search_lang: "en",
    }), new AbortController().signal);

    expect(requested?.pathname).toBe("/res/v1/images/search");
    expect(requested?.searchParams.get("count")).toBe("12");
    expect(requested?.searchParams.get("country")).toBe("US");
    expect(output).toContain("Mountain & lake");
    expect(output).toContain("Image: https://cdn.example/image.jpg");
    expect(output).toContain("Dimensions: 1600x900");
  });

  test("preserves the provider default count when count is omitted", async () => {
    let requested: URL | undefined;
    const tool = createImageSearchTool({
      apiKey: "search-key",
      fetch: async (input) => {
        requested = new URL(String(input));
        return Response.json({ results: [] });
      },
    });
    await tool.execute(tool.validate({ query: "icons" }), new AbortController().signal);
    expect(requested?.searchParams.has("count")).toBe(false);
  });

  test("validates the documented provider limits", () => {
    const tool = createImageSearchTool({ apiKey: "search-key" });
    expect(() => tool.validate({ query: "icons", count: 201 })).toThrow("1 to 200");
    expect(() => tool.validate({ query: "icons", safesearch: "moderate" })).toThrow("strict, off");
  });
});
