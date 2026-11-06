import { validatePluginJsonValue, validatePluginSchema, type PluginJsonSchema } from "../../agent/plugin-schema";

export class PluginToolInputError extends Error {
  constructor(readonly code: "PLUGIN_TOOL_SCHEMA_INVALID" | "PLUGIN_TOOL_INPUT_INVALID", message: string) {
    super(`${code}: ${message}`); this.name = "PluginToolInputError";
  }
}
export type PluginToolInputContract = {
  readonly schema: Record<string, unknown>;
  validate(input: unknown, maxBytes: number): Record<string, unknown>;
};
const openObject: PluginJsonSchema = { type: "object", additionalProperties: true };

/** Plain JSON snapshot before any await. No coercion, defaults, toJSON or dropped undefined. */
export function snapshotPluginToolInput(input: unknown, maxBytes: number, schema: PluginJsonSchema = openObject): Record<string, unknown> {
  try { return validatePluginJsonValue(schema, input, maxBytes) as Record<string, unknown>; }
  catch (error) {
    const oversized = error instanceof Error && error.message === "Runtime JSON payload exceeds its byte limit";
    throw new PluginToolInputError("PLUGIN_TOOL_INPUT_INVALID", oversized ? `Plugin tool input exceeds ${maxBytes} byte limit` : "Tool input must match its schema and contain bounded plain JSON");
  }
}

/** Reuse the configuration dialect, retaining title/description solely as model annotations. */
export function compilePluginToolInputSchema(input: unknown = openObject): PluginToolInputContract {
  try {
    let nodes = 0;
    const normalize = (schema: unknown, depth: number): unknown => {
      if (++nodes > 256 || depth > 16 || !schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("schema");
      const record = schema as Record<string, unknown>, result: Record<string, unknown> = Object.create(null);
      for (const [key, value] of Object.entries(record)) {
        if (key === "title" || key === "description") { if (typeof value !== "string") throw new Error("annotation"); continue; }
        if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
          result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, normalize(child, depth + 1)]));
        } else result[key] = key === "items" ? normalize(value, depth + 1) : value;
      }
      return result;
    };
    // Validate original JSON as well, before annotations can be removed.
    const original = snapshotPluginToolInput(input, 64 * 1024);
    const normalized = normalize(original, 0);
    validatePluginSchema(normalized);
    if (normalized.type !== "object") throw new Error("root");
    return { schema: structuredClone(original), validate: (value, maxBytes) => snapshotPluginToolInput(value, maxBytes, normalized) };
  } catch { throw new PluginToolInputError("PLUGIN_TOOL_SCHEMA_INVALID", "Tool input schema must use the supported bounded object dialect"); }
}
