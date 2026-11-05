import { encodeJson } from "../services/runtime/json";
import type { JsonValue } from "./domain";

/** Deliberately bounded JSON Schema subset. Unsupported keywords fail discovery. */
export type PluginJsonSchema = {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, PluginJsonSchema>; required?: string[]; additionalProperties?: boolean;
  items?: PluginJsonSchema; minItems?: number; maxItems?: number;
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
  enum?: Array<string | number | boolean | null>;
};
export function validatePluginSchema(input: unknown): asserts input is PluginJsonSchema {
  let nodes = 0;
  const visit = (schema: unknown, depth: number) => {
    if (++nodes > 256 || depth > 16 || !schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Invalid or excessive plugin configuration schema");
    const value = schema as Record<string, unknown>, type = value.type;
    const common = ["type", "enum"], fields: Record<string, string[]> = { object: ["properties", "required", "additionalProperties"], array: ["items", "minItems", "maxItems"], string: ["minLength", "maxLength"], number: ["minimum", "maximum"], integer: ["minimum", "maximum"], boolean: [], null: [] };
    if (typeof type !== "string" || !Object.hasOwn(fields, type) || Object.keys(value).some(key => ![...common, ...fields[type]!].includes(key))) throw new Error("Unsupported plugin configuration schema keyword or type");
    for (const [min, max] of type === "string" ? [["minLength", "maxLength"]] : type === "array" ? [["minItems", "maxItems"]] : ["number", "integer"].includes(type) ? [["minimum", "maximum"]] : []) {
      for (const key of [min!, max!]) if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]) || !["number", "integer"].includes(type) && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0))) throw new Error("Invalid plugin configuration schema bounds");
      if (value[min!] !== undefined && value[max!] !== undefined && (value[min!] as number) > (value[max!] as number)) throw new Error("Invalid plugin configuration schema bounds");
    }
    if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 64 || value.enum.some(item => !scalarType(item, type)) || new Set(value.enum.map(item => JSON.stringify(item))).size !== value.enum.length)) throw new Error("Invalid plugin configuration schema enum");
    if (type === "object") {
      const properties = value.properties ?? {};
      if (!properties || typeof properties !== "object" || Array.isArray(properties) || Object.keys(properties).length > 64 || Object.keys(properties).some(key => !key || key.length > 128 || ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("Invalid plugin configuration schema properties");
      for (const schema of Object.values(properties)) visit(schema, depth + 1);
      if (value.required !== undefined && (!Array.isArray(value.required) || new Set(value.required).size !== value.required.length || value.required.some(key => typeof key !== "string" || !Object.hasOwn(properties, key)))) throw new Error("Invalid plugin configuration schema required");
      if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") throw new Error("Invalid plugin configuration schema additionalProperties");
    }
    if (type === "array") { if (!value.items) throw new Error("Plugin configuration array schema requires items"); visit(value.items, depth + 1); }
  };
  visit(input, 0); encodeJson(input, 64 * 1024);
}
function scalarType(value: unknown, type: unknown): boolean {
  return type === "null" ? value === null : type === "integer" ? Number.isSafeInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : ["string", "boolean"].includes(String(type)) && typeof value === type;
}
/** Errors contain only a generic mismatch; configuration values never appear in diagnostics. */
export function validatePluginConfiguration(schema: PluginJsonSchema, value: unknown): JsonValue {
  let nodes = 0;
  const json = (item: unknown, depth: number) => {
    if (++nodes > 8192 || depth > 16) throw new Error("Plugin configuration JSON exceeds structural limits");
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("Plugin configuration must contain plain JSON values");
    for (const entry of Array.isArray(item) ? item : Object.values(item)) json(entry, depth + 1);
  };
  json(value, 0); encodeJson(value, 128 * 1024);
  const check = (schema: PluginJsonSchema, input: unknown, depth: number): void => {
    if (depth > 16) throw new Error("Plugin configuration nesting exceeds limit");
    if (schema.type === "object") {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Plugin configuration does not match schema");
      const record = input as Record<string, unknown>;
      if (schema.required?.some(key => !Object.hasOwn(record, key)) || schema.additionalProperties === false && Object.keys(record).some(key => !Object.hasOwn(schema.properties ?? {}, key))) throw new Error("Plugin configuration does not match schema");
      for (const [key, item] of Object.entries(record)) if (Object.hasOwn(schema.properties ?? {}, key)) check(schema.properties![key]!, item, depth + 1);
    } else if (schema.type === "array") {
      if (!Array.isArray(input) || input.length < (schema.minItems ?? 0) || input.length > (schema.maxItems ?? 4096)) throw new Error("Plugin configuration does not match schema");
      for (const item of input) check(schema.items!, item, depth + 1);
    } else {
      if (!scalarType(input, schema.type)) throw new Error("Plugin configuration does not match schema");
      if (typeof input === "string" && ([...input].length < (schema.minLength ?? 0) || [...input].length > (schema.maxLength ?? 128 * 1024))
        || typeof input === "number" && (input < (schema.minimum ?? -Infinity) || input > (schema.maximum ?? Infinity))) throw new Error("Plugin configuration does not match schema");
    }
    if (schema.enum && !schema.enum.includes(input as never)) throw new Error("Plugin configuration does not match schema");
  };
  // Check before normalization, so undefined required fields cannot disappear silently.
  check(schema, value, 0);
  return JSON.parse(encodeJson(value, 128 * 1024)) as JsonValue;
}
