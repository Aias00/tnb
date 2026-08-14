import { describe, expect, test } from "bun:test";

import {
  buildMcpToolName,
  createMcpResourceTool,
  createMcpResourceUpdatesTool,
  createMcpTools,
} from "../../src/services/mcp/tools";

describe("MCP tool adapter", () => {
  test("qualifies names and forwards calls without trusting server annotations", async () => {
    const calls: unknown[] = [];
    const tools = createMcpTools(
      "issue tracker",
      {
        callTool: async (name, input) => {
          calls.push({ name, input });
          return {
            content: [{ type: "text", text: "created" }],
            structuredContent: { id: 7 },
            isError: false,
          };
        },
      },
      [
        {
          name: "issue.create",
          description: "Create an issue",
          inputSchema: { type: "object", properties: { title: { type: "string" } } },
          annotations: { readOnlyHint: true },
        },
      ],
    );

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("mcp__issue_tracker__issue_create");
    expect(tools[0]?.access).toBe("unknown");
    expect(tools[0]?.isReadOnly({})).toBe(false);
    expect(await tools[0]?.execute({ title: "Bug" }, new AbortController().signal)).toBe(
      'created\n{"id":7}',
    );
    expect(calls).toEqual([{ name: "issue.create", input: { title: "Bug" } }]);
  });

  test("turns MCP execution errors into rejected tool calls", async () => {
    const [tool] = createMcpTools(
      "server",
      {
        callTool: async () => ({
          content: [{ type: "text", text: "Invalid input" }],
          isError: true,
        }),
      },
      [{ name: "check", inputSchema: { type: "object" } }],
    );

    await expect(tool?.execute({}, new AbortController().signal)).rejects.toThrow(
      "Invalid input",
    );
  });

  test("rejects names that collide after provider-safe normalization", () => {
    expect(() =>
      createMcpTools(
        "server",
        { callTool: async () => ({ content: [] }) },
        [
          { name: "same.name", inputSchema: { type: "object" } },
          { name: "same_name", inputSchema: { type: "object" } },
        ],
      ),
    ).toThrow("MCP tool name collision: mcp__server__same_name");
  });

  test("bounds provider-facing names while keeping long names deterministic", () => {
    const first = buildMcpToolName("server-with-a-very-long-name", "tool".repeat(30));
    const second = buildMcpToolName("server-with-a-very-long-name", "tool".repeat(30));

    expect(first.length).toBeLessThanOrEqual(64);
    expect(first).toBe(second);
    expect(first).toMatch(/^mcp__[a-zA-Z0-9_-]+_[a-f0-9]{10}$/);
  });

  test("exposes text and supported media resources without trusting server metadata", async () => {
    const tool = createMcpResourceTool(
      "knowledge",
      {
        readResource: async () => [
          { uri: "memory://guide", text: "guide text" },
          { uri: "memory://diagram", mimeType: "image/png", blob: "aW1hZ2U=" },
        ],
      },
      [{ uri: "memory://guide", name: "Guide", mimeType: "text/plain" }],
    );

    expect(tool.name).toBe("mcp__knowledge__read_resource");
    expect(tool.access).toBe("unknown");
    expect(tool.isReadOnly({ uri: "memory://guide" })).toBe(false);
    expect(await tool.execute({ uri: "memory://guide" }, new AbortController().signal)).toEqual({
      content: "memory://guide\nguide text\n\nImage resource: memory://diagram",
      attachments: [
        {
          type: "image",
          source: { type: "base64", mediaType: "image/png", data: "aW1hZ2U=" },
        },
      ],
    });
  });

  test("advertises URI templates and explicitly subscribes before reading", async () => {
    const calls: string[] = [];
    const tool = createMcpResourceTool(
      "repository",
      {
        async subscribeResource(uri) {
          calls.push(`subscribe:${uri}`);
        },
        async readResource(uri) {
          calls.push(`read:${uri}`);
          return [{ uri, text: "source" }];
        },
      },
      [],
      {
        templates: [{ uriTemplate: "git://repo/{ref}", name: "Git ref" }],
        canSubscribe: true,
      },
    );

    expect(tool.description).toContain("git://repo/{ref}");
    expect((tool.inputSchema.properties as { uri: { enum?: string[] } }).uri.enum).toBeUndefined();
    expect(await tool.execute(
      { uri: "git://repo/main", subscribe: true },
      new AbortController().signal,
    )).toBe("source");
    expect(calls).toEqual(["subscribe:git://repo/main", "read:git://repo/main"]);
  });

  test("lists and optionally clears subscribed resource update markers", async () => {
    const updates = new Set(["memory://b", "memory://a"]);
    const tool = createMcpResourceUpdatesTool("memory", updates);

    expect(await tool.execute({ clear: false }, new AbortController().signal)).toBe(
      '{"updatedResources":["memory://a","memory://b"]}',
    );
    expect(updates.size).toBe(2);
    await tool.execute({ clear: true }, new AbortController().signal);
    expect(updates.size).toBe(0);
  });
});
