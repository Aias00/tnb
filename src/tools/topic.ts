import { defineTool } from "../core/tool";
import type { SessionStore } from "../services/session/storage";

export function createUpdateTopicTool(session: SessionStore) {
  return defineTool<{
    title?: string;
    summary?: string;
    strategicIntent?: string;
  }>({
    name: "update_topic",
    description: "Update durable session topic metadata used by session lists and resume flows. Set a concise title when the conversation acquires a clear task, and refresh the summary or strategic intent only when the user's objective materially changes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", description: "Concise human-readable session title." },
        summary: { type: "string", description: "Short description of the current task and state." },
        strategic_intent: { type: "string", description: "Stable objective guiding the current work." },
      },
      anyOf: [
        { required: ["title"] },
        { required: ["summary"] },
        { required: ["strategic_intent"] },
      ],
    },
    validate(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("update_topic input must be an object");
      }
      const value = input as Record<string, unknown>;
      const title = optionalText(value.title, "update_topic title");
      const summary = optionalText(value.summary, "update_topic summary");
      const strategicIntent = optionalText(value.strategic_intent, "update_topic strategic_intent");
      if (!title && !summary && !strategicIntent) {
        throw new Error("update_topic requires title, summary, or strategic_intent");
      }
      return {
        ...(title ? { title } : {}),
        ...(summary ? { summary } : {}),
        ...(strategicIntent ? { strategicIntent } : {}),
      };
    },
    async execute(input) {
      await session.updateTopic(input);
      return `Session topic updated${input.title ? `: ${input.title}` : "."}`;
    },
    access: "read",
    isReadOnly: () => true,
  });
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
