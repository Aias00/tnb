import type { AgentTool } from "./tool";

export type ToolCatalog = {
  listTools(): AgentTool[];
  getTool(name: string): AgentTool | undefined;
};

export type ToolSearchMatch = {
  name: string;
  description: string;
  score: number;
  active: boolean;
};

export type DeferredToolCatalog = ToolCatalog & {
  search(query: string, options?: { maxResults?: number; activate?: boolean }): ToolSearchMatch[];
  activate(names: Iterable<string>): string[];
  setAuxiliaryTools(tools: AgentTool[]): void;
  deferredCount(): number;
};

export function createDeferredToolCatalog(
  tools: AgentTool[],
  options: { threshold?: number; eagerNames?: Iterable<string> } = {},
): DeferredToolCatalog {
  const eagerCount = Math.max(0, Math.min(options.threshold ?? tools.length, tools.length));
  const eagerNames = new Set([...(options.eagerNames ?? [])].map((name) => name.toLowerCase()));
  const eager = new Map<string, AgentTool>();
  const deferred = new Map<string, AgentTool>();
  const auxiliary = new Map<string, AgentTool>();

  tools.forEach((tool, index) => {
    if (index < eagerCount || eagerNames.has(tool.name.toLowerCase())) eager.set(tool.name, tool);
    else deferred.set(tool.name, tool);
  });

  function listedTools(): AgentTool[] {
    return [...eager.values(), ...auxiliary.values()];
  }

  return {
    listTools() {
      return listedTools();
    },
    getTool(name) {
      return eager.get(name) ?? auxiliary.get(name);
    },
    search(query, searchOptions = {}) {
      const maxResults = Math.max(1, searchOptions.maxResults ?? 8);
      const normalizedQuery = normalizeQuery(query);
      const matches = [...eager.values(), ...deferred.values()]
        .map((tool) => ({
          tool,
          score: scoreTool(tool, normalizedQuery),
          active: eager.has(tool.name) || auxiliary.has(tool.name),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
        .slice(0, maxResults);
      if (searchOptions.activate !== false) {
        for (const entry of matches) {
          if (deferred.has(entry.tool.name)) {
            eager.set(entry.tool.name, entry.tool);
            deferred.delete(entry.tool.name);
            entry.active = true;
          }
        }
      }
      return matches.map(({ tool, score, active }) => ({
        name: tool.name,
        description: tool.description,
        score,
        active,
      }));
    },
    activate(names) {
      const activated: string[] = [];
      for (const name of names) {
        const tool = deferred.get(name);
        if (!tool) continue;
        deferred.delete(name);
        eager.set(name, tool);
        activated.push(name);
      }
      return activated;
    },
    setAuxiliaryTools(tools) {
      auxiliary.clear();
      for (const tool of tools) auxiliary.set(tool.name, tool);
    },
    deferredCount() {
      return deferred.size;
    },
  };
}

function normalizeQuery(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9_]+/i).map((part) => part.trim()).filter(Boolean);
}

function scoreTool(tool: AgentTool, queryParts: string[]): number {
  if (queryParts.length === 0) return 0;
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let matchedParts = 0;
  let score = 0;
  for (const part of queryParts) {
    const inName = name.includes(part);
    const inDescription = description.includes(part);
    if (name === part) score += 10;
    else if (inName) score += 6;
    if (inDescription) score += 3;
    const matched = inName || inDescription;
    if (matched) matchedParts += 1;
  }
  if (name.includes(queryParts.join("_"))) score += 4;
  return matchedParts === queryParts.length ? score : 0;
}
