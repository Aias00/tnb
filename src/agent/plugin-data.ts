import type { JsonValue } from "./domain";
import type { PluginJsonSchema } from "./plugin-schema";
import { validatePluginSchema } from "./plugin-schema";
import { encodeJson } from "../services/runtime/json";

export type PluginConfigurationContract = { version: number; schema: PluginJsonSchema };
export type VersionedPluginConfiguration = { version: number; value: JsonValue };
export type PluginConfiguration = Record<string, Record<string, VersionedPluginConfiguration>>;
export type PluginStateContract = { version: number; migrations?: Array<{ from: number; to: number }> };
export type PluginDataDeclaration = { configuration?: PluginConfigurationContract; state?: PluginStateContract };
export function parsePluginConfiguration(value: unknown): PluginConfiguration {
  if (!record(value) || Object.keys(value).length > 128) throw new Error("Invalid pluginConfiguration");
  for (const [name, entries] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || !record(entries) || Object.keys(entries).length > 32) throw new Error("Invalid pluginConfiguration package or entries");
    for (const [key, entry] of Object.entries(entries)) {
      if (!/^(application|interface):[A-Za-z0-9][A-Za-z0-9._-]{0,127}@[^\s@]{1,128}$/.test(key) || !record(entry)
        || Object.keys(entry).some(key => !["version", "value"].includes(key)) || !version(entry.version) || !Object.hasOwn(entry, "value")) throw new Error("Invalid pluginConfiguration contribution or envelope");
    }
  }
  try { return JSON.parse(encodeJson(value, 128 * 1024)) as PluginConfiguration; }
  catch { throw new Error("Invalid pluginConfiguration JSON or size"); }
}
export function contributionConfigurationKey(ref: { kind: string; id: string; version: string }): string { return `${ref.kind}:${ref.id}@${ref.version}`; }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function parsePluginDataDeclaration(value: PluginDataDeclaration, kind: string): PluginDataDeclaration {
  const result: PluginDataDeclaration = {};
  if (value.configuration !== undefined) {
    const config: unknown = value.configuration;
    if (kind === "channel" || !record(config) || Object.keys(config).some(key => !["version", "schema"].includes(key)) || !version(config.version)) throw new Error("Invalid plugin configuration contract; only applications/interfaces accept host configuration");
    validatePluginSchema(config.schema); result.configuration = structuredClone(config) as PluginConfigurationContract;
  }
  if (value.state !== undefined) {
    const state: unknown = value.state;
    if (!record(state) || Object.keys(state).some(key => !["version", "migrations"].includes(key)) || !version(state.version)) throw new Error("Invalid plugin state contract");
    const steps = state.migrations ?? [];
    if (!Array.isArray(steps) || steps.length > 32 || steps.some(step => !record(step) || Object.keys(step).some(key => !["from", "to"].includes(key)) || !Number.isSafeInteger(step.from) || (step.from as number) < 0 || !version(step.to) || (step.to as number) <= (step.from as number) || (step.to as number) > (state.version as number)) || new Set(steps.map(step => step.from)).size !== steps.length) throw new Error("Invalid or ambiguous plugin state migration declarations");
    result.state = structuredClone(state) as PluginStateContract;
  }
  return result;
}
export function version(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 999; }
export class PluginDataError extends Error {
  constructor(readonly code: "PLUGIN_CONFIG_INVALID" | "PLUGIN_STATE_INCOMPATIBLE" | "PLUGIN_STATE_MIGRATION_FAILED", detail: string) { super(`${code}: ${detail}`); this.name = "PluginDataError"; }
}
