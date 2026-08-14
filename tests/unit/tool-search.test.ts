import { describe, expect, test } from "bun:test";

import { createPermissionChecker } from "../../src/core/permissions";
import { defineTool, type AgentTool } from "../../src/core/tool";
import { createDeferredToolCatalog } from "../../src/core/tool-search";
import { createToolSearchTool } from "../../src/tools/tool-search";

describe("deferred tool search catalog", () => {
  test("hides deferred tools, activates searched matches, and keeps MCP names stable", async () => {
    const read = fakeTool("read", "Read a file", "read");
    const write = fakeTool("write", "Write a file", "write");
    const mcp = fakeTool(
      "mcp__issue_tracker__search_issue",
      "Search issues from the issue tracker MCP server",
      "unknown",
    );
    const catalog = createDeferredToolCatalog([read, write, mcp], { threshold: 1 });
    const toolSearch = createToolSearchTool(catalog);
    catalog.setAuxiliaryTools([toolSearch]);

    expect(catalog.listTools().map((tool) => tool.name)).toEqual(["read", "tool_search"]);
    expect(catalog.getTool("write")).toBeUndefined();
    expect(catalog.getTool("mcp__issue_tracker__search_issue")).toBeUndefined();

    const result = await toolSearch.execute(
      toolSearch.validate({ query: "issue tracker search", maxResults: 2 }),
      new AbortController().signal,
    );
    const payload = JSON.parse(result) as {
      matches: Array<{ name: string }>;
      activated: string[];
      remainingDeferred: number;
    };

    expect(payload.matches.map((match) => match.name)).toEqual(["mcp__issue_tracker__search_issue"]);
    expect(payload.activated).toEqual(["mcp__issue_tracker__search_issue"]);
    expect(payload.remainingDeferred).toBe(1);
    expect(catalog.listTools().map((tool) => tool.name)).toEqual([
      "read",
      "mcp__issue_tracker__search_issue",
      "tool_search",
    ]);
    expect(catalog.getTool("mcp__issue_tracker__search_issue")?.name).toBe(
      "mcp__issue_tracker__search_issue",
    );
  });

  test("preserves permission behavior after activation and cannot discover filtered-out tools", async () => {
    const read = fakeTool("read", "Read a file", "read");
    const write = fakeTool("write", "Write a file", "write");
    const catalog = createDeferredToolCatalog([read, write], { threshold: 1 });
    const toolSearch = createToolSearchTool(catalog);
    catalog.setAuxiliaryTools([toolSearch]);

    await toolSearch.execute(
      toolSearch.validate({ query: "write file" }),
      new AbortController().signal,
    );

    const checker = createPermissionChecker({ mode: "default" });
    expect(await checker(asPolicy(write), { path: "notes.txt" })).toEqual({
      behavior: "deny",
      message: "write requires approval, but prompting is unavailable in non-interactive mode",
    });
    expect(await checker(asPolicy(catalog.getTool("write")!), { path: "notes.txt" })).toEqual({
      behavior: "deny",
      message: "write requires approval, but prompting is unavailable in non-interactive mode",
    });

    const filteredCatalog = createDeferredToolCatalog([read], { threshold: 1 });
    const filteredSearch = createToolSearchTool(filteredCatalog);
    filteredCatalog.setAuxiliaryTools([filteredSearch]);
    const filteredResult = await filteredSearch.execute(
      filteredSearch.validate({ query: "write file" }),
      new AbortController().signal,
    );
    const filteredPayload = JSON.parse(filteredResult) as { matches: unknown[]; activated: string[] };

    expect(filteredPayload.matches).toEqual([]);
    expect(filteredPayload.activated).toEqual([]);
    expect(filteredCatalog.listTools().map((tool) => tool.name)).toEqual(["read", "tool_search"]);
  });
});

function fakeTool(
  name: string,
  description: string,
  access: "read" | "write" | "execute" | "network" | "unknown",
) {
  return defineTool({
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      additionalProperties: true,
    },
    validate(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
      return input as Record<string, unknown>;
    },
    async execute() {
      return name;
    },
    access,
    isReadOnly: () => access === "read",
    isConcurrencySafe: () => access === "read",
    permissionRuleContent(input) {
      return typeof input.path === "string" ? input.path : undefined;
    },
  });
}

function asPolicy(tool: AgentTool) {
  return {
    name: tool.name,
    risk: tool.access,
    isReadOnly: tool.isReadOnly,
    ...(tool.requiresApproval ? { requiresApproval: tool.requiresApproval } : {}),
    ...(tool.permissionRuleContent ? { permissionRuleContent: tool.permissionRuleContent } : {}),
  };
}
