import { expect, test } from "bun:test";
import { parsePluginConfiguration, parsePluginDataDeclaration } from "../../src/agent/plugin-data";
import { validatePluginSchema, validatePluginConfiguration, type PluginJsonSchema } from "../../src/agent/plugin-schema";
import { bindPluginMigrations } from "../../src/agent/plugin-state";

const schema: PluginJsonSchema = { type: "object", properties: { label: { type: "string", minLength: 1, maxLength: 8 }, count: { type: "integer", minimum: 0, maximum: 4 },
  flags: { type: "array", minItems: 1, maxItems: 2, items: { type: "boolean", enum: [true] } } }, required: ["label", "count"], additionalProperties: false };

test("bounded schema validates strict JSON without defaults, coercion or unknown fields", () => {
  validatePluginSchema(schema);
  expect(validatePluginConfiguration(schema, { label: "汉字", count: 2, flags: [true] })).toEqual({ label: "汉字", count: 2, flags: [true] });
  for (const value of [{ label: "", count: 1 }, { label: "ok", count: "2" }, { label: "ok", count: 0.5 }, { label: "ok", count: 5 }, { count: 2 },
    { label: "ok", count: 2, unknown: "secret-value" }, { label: "ok", count: 2, flags: [false] }, { label: "ok", count: 2, flags: [true, true, true] }]) {
    expect(() => validatePluginConfiguration(schema, value)).toThrow("does not match");
    try { validatePluginConfiguration(schema, value); } catch (error) { expect(String(error)).not.toContain("secret-value"); }
  }
});

test("unsupported schema keywords and malformed bounds fail before plugin execution", () => {
  for (const invalid of [{ type: "string", pattern: "(a+)+" }, { type: "object", $ref: "https://example.com/schema" }, { type: "string", default: "ignored" },
    { type: ["string", "null"] }, { type: "string", maxLength: -1 }, { type: "number", minimum: 10, maximum: 1 }, { type: "object", required: ["missing"] },
    { type: "array" }, { type: "string", enum: [true] }, { type: "boolean", enum: [true, true] }, { type: "object", properties: { constructor: { type: "string" } } }]) {
    expect(() => validatePluginSchema(invalid)).toThrow("schema");
  }
});

test("schema nesting, nodes and data size have finite ceilings", () => {
  let nested: unknown = { type: "string" }; for (let i = 0; i < 18; i++) nested = { type: "array", items: nested };
  expect(() => validatePluginSchema(nested)).toThrow("excessive");
  const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), { type: "string" }])) };
  expect(() => validatePluginSchema(wide)).toThrow("properties");
  expect(() => validatePluginConfiguration({ type: "string" }, "x".repeat(130 * 1024))).toThrow();
  expect(() => validatePluginConfiguration({ type: "object" }, { secret: undefined })).toThrow("JSON");
  expect(() => validatePluginConfiguration({ type: "object" }, new Date())).toThrow("JSON");
});

test("null, numeric enum, empty array and open objects keep their declared semantics", () => {
  expect(validatePluginConfiguration({ type: "null" }, null)).toBeNull();
  expect(validatePluginConfiguration({ type: "number", enum: [1.5, 2] }, 1.5)).toBe(1.5);
  expect(validatePluginConfiguration({ type: "array", items: { type: "string" } }, [])).toEqual([]);
  expect(validatePluginConfiguration({ type: "object" }, { arbitrary: [1, null] })).toEqual({ arbitrary: [1, null] });
});

test("contribution contracts are explicit, bounded and cannot accept channel host configuration", () => {
  expect(parsePluginDataDeclaration({ state: { version: 2, migrations: [{ from: 0, to: 1 }, { from: 1, to: 2 }] } }, "channel").state?.version).toBe(2);
  for (const state of [{ version: 0 }, { version: 1000 }, { version: 2, migrations: [{ from: 1, to: 1 }] }, { version: 2, migrations: [{ from: 0, to: 1 }, { from: 0, to: 2 }] }]) {
    expect(() => parsePluginDataDeclaration({ state } as never, "application")).toThrow("state");
  }
  expect(() => parsePluginDataDeclaration({ configuration: { version: 1, schema } }, "channel")).toThrow("only applications");
  expect(() => bindPluginMigrations({ version: 2, migrations: [{ from: 1, to: 2 }] }, [])).toThrow("exactly");
  expect(() => bindPluginMigrations({ version: 2, migrations: [{ from: 1, to: 2 }] }, [{ from: 1, to: 2, migrate: async () => {} }])).toThrow("synchronously");
});

test("host configuration envelopes reject unknown keys, versions and non-JSON payloads without echoing secrets", () => {
  expect(parsePluginConfiguration({ pack: { "application:panel@1": { version: 1, value: { label: "ok" } } } })).toEqual({ pack: { "application:panel@1": { version: 1, value: { label: "ok" } } } });
  for (const invalid of [{ pack: { "channel:notes@1": { version: 1, value: {} } } }, { pack: { "application:panel@1": { version: 0, value: {} } } },
    { pack: { "application:panel@1": { version: 1, value: "private-config-secret", unexpected: true } } }, { pack: { "application:panel@1": { version: 1, value: () => {} } } }]) {
    expect(() => parsePluginConfiguration(invalid)).toThrow("pluginConfiguration");
    try { parsePluginConfiguration(invalid); } catch (error) { expect(String(error)).not.toContain("private-config-secret"); }
  }
});
