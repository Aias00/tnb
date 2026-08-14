import { defineTool } from "../core/tool";
import type { DeferredToolCatalog } from "../core/tool-search";

export function createToolSearchTool(catalog: DeferredToolCatalog) {
  return defineTool({
    name: "tool_search",
    description: [
      "Search deferred tool schemas and activate matching tools for later turns.",
      "Use this when a needed tool is not currently exposed in the tool list.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language description of the tool you want to use.",
        },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Optional maximum number of matches to return. Defaults to 8.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    validate(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("tool_search input must be an object");
      }
      const value = input as { query?: unknown; maxResults?: unknown };
      if (typeof value.query !== "string" || !value.query.trim()) {
        throw new Error("tool_search query must be a non-empty string");
      }
      if (
        value.maxResults !== undefined &&
        (!Number.isInteger(value.maxResults) || (value.maxResults as number) < 1 || (value.maxResults as number) > 20)
      ) {
        throw new Error("tool_search maxResults must be an integer between 1 and 20");
      }
      return {
        query: value.query.trim(),
        ...(value.maxResults === undefined ? {} : { maxResults: value.maxResults as number }),
      };
    },
    async execute(input) {
      const matches = catalog.search(input.query, { maxResults: input.maxResults, activate: true });
      return JSON.stringify({
        query: input.query,
        matches,
        activated: matches.filter((match) => match.active).map((match) => match.name),
        remainingDeferred: catalog.deferredCount(),
      });
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    permissionRuleContent: ({ query }) => query,
  });
}
