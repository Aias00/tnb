import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ReasoningEffort } from "../../providers/factory";
import {
  HOOK_EVENTS,
  type HookEvent,
  type HookHandler,
  type HookMatcher,
  type HooksConfig,
} from "../hooks/runner";

export type SkillSource = "user" | "project" | "plugin" | "bundled";
export type SkillEffort = ReasoningEffort | "auto" | "max" | number;
export type FrontmatterValue =
  | string
  | boolean
  | number
  | null
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };

export type LoadedSkill = {
  name: string;
  aliases?: string[];
  description: string;
  allowedTools?: string[];
  keywords?: string[];
  whenToUse?: string;
  argumentHint?: string;
  argumentNames?: string[];
  model?: string;
  version?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  context?: "inline" | "fork";
  agent?: string;
  effort?: SkillEffort;
  hooks?: HooksConfig;
  paths?: string[];
  resources?: string[];
  instructions: string;
  baseDir: string;
  source: SkillSource;
};

export function parseSkillMarkdown(
  markdown: string,
  path: string,
): Omit<LoadedSkill, "baseDir" | "source"> {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) throw new Error(`Skill frontmatter is required: ${path}`);
  const fields = parseFrontmatterFields(match[1] ?? "", path);
  const name = requiredFrontmatterString(fields.name, "name", path);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  const description = requiredFrontmatterString(fields.description, "description", path);
  const instructions = markdown.slice(match[0].length).trim();
  if (!instructions) throw new Error(`Skill instructions are required: ${path}`);
  const allowedTools = frontmatterStringList(fields["allowed-tools"], "allowed-tools", path);
  const aliases = frontmatterStringList(fields.aliases, "aliases", path);
  if (aliases?.some((alias) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(alias))) {
    throw new Error(`Invalid skill alias in ${path}`);
  }
  const keywords = frontmatterStringList(fields.keywords, "keywords", path);
  const whenToUse = optionalFrontmatterString(fields.when_to_use ?? fields["when-to-use"], "when_to_use", path);
  const argumentHint = optionalFrontmatterString(fields["argument-hint"], "argument-hint", path);
  const argumentNames = frontmatterStringList(fields.arguments, "arguments", path);
  const model = optionalFrontmatterString(fields.model, "model", path);
  const version = optionalFrontmatterString(fields.version, "version", path);
  const disableModelInvocation = optionalFrontmatterBoolean(
    fields["disable-model-invocation"],
    "disable-model-invocation",
    path,
  );
  const userInvocable = fields["user-invocable"] === undefined
    ? true
    : requiredFrontmatterBoolean(fields["user-invocable"], "user-invocable", path);
  const context = optionalFrontmatterContext(fields.context, "context", path);
  const agent = optionalFrontmatterString(fields.agent, "agent", path);
  const effort = optionalFrontmatterEffort(fields.effort, "effort", path);
  const hooks = optionalFrontmatterHooks(fields.hooks, "hooks", path);
  const paths = frontmatterPathList(fields.paths, "paths", path);
  return {
    name,
    description,
    ...(aliases === undefined ? {} : { aliases }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(keywords === undefined ? {} : { keywords }),
    ...(whenToUse === undefined ? {} : { whenToUse }),
    ...(argumentHint === undefined ? {} : { argumentHint }),
    ...(argumentNames === undefined ? {} : { argumentNames }),
    ...(model === undefined || model === "inherit" ? {} : { model }),
    ...(version === undefined ? {} : { version }),
    ...(disableModelInvocation === undefined ? {} : { disableModelInvocation }),
    ...(userInvocable ? {} : { userInvocable }),
    ...(context === undefined ? {} : { context }),
    ...(agent === undefined ? {} : { agent }),
    ...(effort === undefined ? {} : { effort }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(paths === undefined ? {} : { paths }),
    instructions,
  };
}

export async function loadSkills(
  sources: Array<{ directory: string; source: SkillSource }>,
  bundled: LoadedSkill[] = [],
): Promise<LoadedSkill[]> {
  const loaded = new Map<string, LoadedSkill>();
  for (const source of sources) {
    let entries;
    try {
      entries = await readdir(source.directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const baseDir = join(source.directory, entry.name);
      const filePath = join(baseDir, "SKILL.md");
      let markdown: string;
      try {
        markdown = await readFile(filePath, "utf8");
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      const skill = parseSkillMarkdown(markdown, filePath);
      const key = skill.name.toLowerCase();
      if (!loaded.has(key)) {
        const resources = await listSkillResources(baseDir);
        loaded.set(key, {
          ...skill,
          ...(resources.length ? { resources } : {}),
          baseDir,
          source: source.source,
        });
      }
    }
  }
  for (const skill of bundled) {
    const key = skill.name.toLowerCase();
    if (!loaded.has(key)) loaded.set(key, structuredClone(skill));
  }
  return [...loaded.values()];
}

export function renderSkillPrompt(skill: LoadedSkill, argumentsText: string): string {
  const instructions = substituteSkillArguments(
    skill.instructions,
    argumentsText,
    skill.argumentNames ?? [],
  )
    .replaceAll("${TNB_SKILL_DIR}", skill.baseDir)
    .replaceAll("${CLAUDE_SKILL_DIR}", skill.baseDir);
  const resources = skill.resources?.length
    ? `\n\nSupporting resources (load only what the task requires):\n${skill.resources.map((path) => `- ${path}`).join("\n")}`
    : "";
  return `Skill base directory: ${skill.baseDir}${resources}\n\n${instructions}`;
}

export function skillDiscoveryDescription(skill: LoadedSkill): string {
  const applicability = skill.whenToUse
    ? ` When to use: ${skill.whenToUse}`
    : skill.keywords?.length
      ? ` Trigger terms: ${skill.keywords.join(", ")}.`
      : "";
  const argumentsHint = skill.argumentHint
    ? ` Arguments: ${skill.argumentHint}.`
    : skill.argumentNames?.length
      ? ` Arguments: ${skill.argumentNames.join(" ")}.`
      : "";
  const execution = skill.context || skill.agent || skill.effort
    ? ` Execution: ${[
      skill.context ? `context=${skill.context}` : undefined,
      skill.agent ? `agent=${skill.agent}` : undefined,
      skill.effort !== undefined ? `effort=${String(skill.effort)}` : undefined,
    ].filter(Boolean).join(", ")}.`
    : "";
  const paths = skill.paths?.length ? ` Applies to paths: ${skill.paths.join(", ")}.` : "";
  return `${skill.description}${applicability}${paths}${argumentsHint}${execution}`;
}

export function parseFrontmatterFields(
  text: string,
  path: string,
): Record<string, any> {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  return parseFrontmatterMap(lines, 0, 0, path)[0] as Record<string, any>;
}

export function requiredFrontmatterString(
  value: FrontmatterValue | undefined,
  field: string,
  path: string,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Skill ${field} is required: ${path}`);
  }
  return value.trim();
}

export function frontmatterStringList(
  value: FrontmatterValue | undefined,
  field: string,
  path: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value)
    ? value.map((item) => {
      if (typeof item !== "string") throw new Error(`Skill ${field} must contain only strings: ${path}`);
      return item.trim();
    })
    : typeof value === "string"
      ? value.split(",").map((item) => item.trim())
      : (() => {
        throw new Error(`Skill ${field} must be a string or string list: ${path}`);
      })();
  if (values.some((item) => !item)) throw new Error(`Skill ${field} contains an empty value: ${path}`);
  return values;
}

async function listSkillResources(baseDir: string, currentDir = baseDir): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const resources: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) continue;
    const path = join(currentDir, entry.name);
    if (entry.isDirectory()) resources.push(...await listSkillResources(baseDir, path));
    else if (entry.isFile() && !(currentDir === baseDir && entry.name === "SKILL.md")) {
      resources.push(path.slice(baseDir.length + 1).replaceAll("\\", "/"));
    }
  }
  return resources;
}

function optionalFrontmatterString(
  value: FrontmatterValue | undefined,
  field: string,
  path: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Skill ${field} must be a non-empty string: ${path}`);
  }
  return value.trim();
}

function requiredFrontmatterBoolean(
  value: FrontmatterValue | undefined,
  field: string,
  path: string,
): boolean {
  const parsed = optionalFrontmatterBoolean(value, field, path);
  if (parsed === undefined) throw new Error(`Skill ${field} is required: ${path}`);
  return parsed;
}

function optionalFrontmatterBoolean(
  value: FrontmatterValue | undefined,
  field: string,
  path: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Skill ${field} must be true or false: ${path}`);
}

function optionalFrontmatterContext(
  value: FrontmatterValue | undefined,
  field: string,
  path: string,
): "inline" | "fork" | undefined {
  if (value === undefined) return undefined;
  if (value === "inline" || value === "fork") return value;
  throw new Error(`Skill ${field} must be inline or fork: ${path}`);
}

function optionalFrontmatterEffort(
  value: FrontmatterValue | undefined,
  field: string,
  path: string,
): SkillEffort | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Skill ${field} must be a positive integer or named effort: ${path}`);
    }
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Skill ${field} must be a positive integer or named effort: ${path}`);
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`Skill ${field} must be a positive integer or named effort: ${path}`);
    }
    return parsed;
  }
  if (["off", "minimal", "low", "medium", "high", "xhigh", "auto", "max"].includes(trimmed)) {
    return trimmed as SkillEffort;
  }
  throw new Error(`Skill ${field} must be a positive integer or named effort: ${path}`);
}

function optionalFrontmatterHooks(
  value: FrontmatterValue | undefined,
  field: string,
  path: string,
): HooksConfig | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string"
    ? parseHooksJson(value, field, path)
    : value;
  if (!isRecord(parsed)) throw new Error(`Skill ${field} must be an object keyed by hook event: ${path}`);
  const events = new Set(HOOK_EVENTS);
  const config: HooksConfig = {};
  for (const [event, groups] of Object.entries(parsed)) {
    if (!events.has(event as HookEvent)) {
      throw new Error(`Skill ${field} contains an unknown hook event '${event}': ${path}`);
    }
    if (!Array.isArray(groups)) {
      throw new Error(`Skill ${field}.${event} must be an array of matchers: ${path}`);
    }
    config[event as HookEvent] = groups.map((group, index) =>
      normalizeHookMatcher(group, `${field}.${event}[${index}]`, path));
  }
  return config;
}

function frontmatterPathList(
  value: FrontmatterValue | undefined,
  field: string,
  path: string,
): string[] | undefined {
  const patterns = frontmatterStringList(value, field, path)
    ?.map((pattern) => pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern)
    .filter(Boolean);
  if (!patterns?.length || patterns.every((pattern) => pattern === "**")) return undefined;
  return patterns;
}

function parseFrontmatterMap(
  lines: string[],
  start: number,
  indent: number,
  path: string,
): [Record<string, FrontmatterValue>, number] {
  const fields: Record<string, FrontmatterValue> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (isIgnorableLine(line)) {
      index += 1;
      continue;
    }
    const currentIndent = indentation(line);
    if (currentIndent < indent) break;
    if (currentIndent > indent) throw new Error(`Invalid skill frontmatter at ${path}:${index + 2}`);
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) throw new Error(`Invalid skill frontmatter at ${path}:${index + 2}`);
    const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_-]*):(?:\s+(.*)|\s*)$/);
    if (!match) throw new Error(`Invalid skill frontmatter at ${path}:${index + 2}`);
    const key = match[1] as string;
    const raw = match[2] ?? "";
    let value: FrontmatterValue;
    let nextIndex = index + 1;
    if (raw === "|" || raw === ">") {
      [value, nextIndex] = parseBlockScalar(lines, index + 1, currentIndent, raw);
    } else if (raw) {
      value = parseInlineValue(raw, path, index);
    } else {
      [value, nextIndex] = parseNestedFrontmatterValue(lines, index + 1, currentIndent, path);
    }
    fields[key] = value;
    index = nextIndex;
  }
  return [fields, index];
}

function parseNestedFrontmatterValue(
  lines: string[],
  start: number,
  parentIndent: number,
  path: string,
): [FrontmatterValue, number] {
  const nextLine = nextMeaningfulLine(lines, start);
  if (nextLine >= lines.length) return [[], lines.length];
  const indent = indentation(lines[nextLine] ?? "");
  if (indent <= parentIndent) return [[], nextLine];
  return (lines[nextLine] ?? "").trim().startsWith("- ")
    ? parseFrontmatterList(lines, nextLine, indent, path)
    : parseFrontmatterMap(lines, nextLine, indent, path);
}

function parseFrontmatterList(
  lines: string[],
  start: number,
  indent: number,
  path: string,
): [FrontmatterValue[], number] {
  const values: FrontmatterValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (isIgnorableLine(line)) {
      index += 1;
      continue;
    }
    const currentIndent = indentation(line);
    if (currentIndent < indent) break;
    if (currentIndent > indent) throw new Error(`Invalid skill frontmatter at ${path}:${index + 2}`);
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) throw new Error(`Invalid skill frontmatter at ${path}:${index + 2}`);
    const remainder = trimmed.slice(2).trimStart();
    const [value, nextIndex] = parseFrontmatterListItem(lines, index, indent, remainder, path);
    values.push(value);
    index = nextIndex;
  }
  return [values, index];
}

function parseFrontmatterListItem(
  lines: string[],
  index: number,
  indent: number,
  remainder: string,
  path: string,
): [FrontmatterValue, number] {
  if (remainder === "|" || remainder === ">") {
    return parseBlockScalar(lines, index + 1, indent, remainder);
  }
  if (!remainder) return parseNestedFrontmatterValue(lines, index + 1, indent, path);
  if (looksLikeFrontmatterKey(remainder)) {
    const childIndent = indent + 2;
    const nestedLines = [`${" ".repeat(childIndent)}${remainder}`];
    let nextIndex = index + 1;
    while (nextIndex < lines.length) {
      const line = lines[nextIndex] ?? "";
      if (isIgnorableLine(line)) {
        nestedLines.push(line);
        nextIndex += 1;
        continue;
      }
      if (indentation(line) <= indent) break;
      nestedLines.push(line);
      nextIndex += 1;
    }
    return [parseFrontmatterMap(nestedLines, 0, childIndent, path)[0], nextIndex];
  }
  return [parseInlineValue(remainder, path, index), index + 1];
}

function parseBlockScalar(
  lines: string[],
  start: number,
  parentIndent: number,
  style: "|" | ">",
): [string, number] {
  const values: string[] = [];
  let minIndent = Number.POSITIVE_INFINITY;
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      const nextLine = nextNonBlankLine(lines, index + 1);
      if (nextLine >= lines.length || indentation(lines[nextLine] ?? "") <= parentIndent) break;
      values.push("");
      index += 1;
      continue;
    }
    const currentIndent = indentation(line);
    if (currentIndent <= parentIndent) break;
    minIndent = Math.min(minIndent, currentIndent);
    values.push(line);
    index += 1;
  }
  if (!values.length) return ["", index];
  const normalized = values.map((line) => line ? line.slice(minIndent) : "");
  return [
    style === ">"
      ? normalized.map((line) => line.trim()).join(" ").replace(/\s+/g, " ").trim()
      : normalized.join("\n").replace(/\s+$/u, ""),
    index,
  ];
}

function parseInlineValue(raw: string, path: string, index: number): FrontmatterValue {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return parseInlineArray(value.slice(1, -1), path, index);
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      return parsed as Record<string, FrontmatterValue>;
    } catch {
      return unquote(value);
    }
  }
  return parseScalar(value);
}

function parseInlineArray(raw: string, path: string, index: number): FrontmatterValue[] {
  const values: FrontmatterValue[] = [];
  for (const part of splitTopLevel(raw)) {
    const candidate = part.trim();
    if (!candidate) throw new Error(`Invalid skill frontmatter at ${path}:${index + 2}`);
    values.push(parseInlineValue(candidate, path, index));
  }
  return values;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (quote) {
      current += character;
      if (character === quote && value[index - 1] !== "\\") quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "[" || character === "{") {
      depth += 1;
      current += character;
      continue;
    }
    if (character === "]" || character === "}") {
      depth = Math.max(0, depth - 1);
      current += character;
      continue;
    }
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}

function substituteSkillArguments(
  content: string,
  argumentsText: string,
  argumentNames: string[],
): string {
  const parsedArguments = splitSkillArguments(argumentsText);
  let substituted = content;
  for (const [index, name] of argumentNames.entries()) {
    const escaped = escapeRegExp(name);
    substituted = substituted.replace(
      new RegExp(`\\$${escaped}(?![\\[\\w])`, "g"),
      parsedArguments[index] ?? "",
    );
  }
  substituted = substituted.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, value: string) => {
    const index = Number.parseInt(value, 10);
    return Number.isNaN(index) ? "" : parsedArguments[index] ?? "";
  });
  substituted = substituted.replace(/\$(\d+)(?![\w\]])/g, (_, value: string) => {
    const index = Number.parseInt(value, 10);
    return Number.isNaN(index) ? "" : parsedArguments[index] ?? "";
  });
  return substituted.replaceAll("$ARGUMENTS", argumentsText);
}

function splitSkillArguments(value: string): string[] {
  return [...value.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

function parseScalar(value: string): FrontmatterValue {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return unquote(value);
}

function normalizeHookMatcher(
  value: FrontmatterValue,
  field: string,
  path: string,
): HookMatcher {
  if (!isRecord(value)) throw new Error(`Skill ${field} must be an object: ${path}`);
  const hooks = value.hooks;
  if (!Array.isArray(hooks)) throw new Error(`Skill ${field}.hooks must be an array: ${path}`);
  const matcher = optionalRecordString(value.matcher, `${field}.matcher`, path);
  const sequential = optionalRecordBoolean(value.sequential, `${field}.sequential`, path);
  const async = optionalRecordBoolean(value.async, `${field}.async`, path);
  return {
    ...(matcher === undefined ? {} : { matcher }),
    hooks: hooks.map((hook, index) => normalizeHookHandler(hook, `${field}.hooks[${index}]`, path)),
    ...(sequential === undefined ? {} : { sequential }),
    ...(async === undefined ? {} : { async }),
  };
}

function normalizeHookHandler(
  value: FrontmatterValue,
  field: string,
  path: string,
): HookHandler {
  if (!isRecord(value)) throw new Error(`Skill ${field} must be an object: ${path}`);
  const type = requiredRecordString(value.type, `${field}.type`, path);
  const base = {
    ...(optionalRecordString(value.name, `${field}.name`, path) === undefined
      ? {}
      : { name: optionalRecordString(value.name, `${field}.name`, path)! }),
    ...(optionalRecordNumber(value.timeout, `${field}.timeout`, path) === undefined
      ? {}
      : { timeout: optionalRecordNumber(value.timeout, `${field}.timeout`, path)! }),
    ...(optionalRecordString(value.if, `${field}.if`, path) === undefined
      ? {}
      : { if: optionalRecordString(value.if, `${field}.if`, path)! }),
    ...(optionalRecordBoolean(value.async, `${field}.async`, path) === undefined
      ? {}
      : { async: optionalRecordBoolean(value.async, `${field}.async`, path)! }),
  };
  if (type === "command") {
    return {
      ...base,
      type,
      command: requiredRecordString(value.command, `${field}.command`, path),
      ...(recordStringList(value.args, `${field}.args`, path) === undefined
        ? {}
        : { args: recordStringList(value.args, `${field}.args`, path)! }),
    };
  }
  if (type === "http") {
    return {
      ...base,
      type,
      url: requiredRecordString(value.url, `${field}.url`, path),
      ...(recordStringMap(value.headers, `${field}.headers`, path) === undefined
        ? {}
        : { headers: recordStringMap(value.headers, `${field}.headers`, path)! }),
    };
  }
  if (type === "prompt") {
    return {
      ...base,
      type,
      prompt: requiredRecordString(value.prompt, `${field}.prompt`, path),
    };
  }
  if (type === "agent") {
    const maxTurns = optionalRecordNumber(value.maxTurns, `${field}.maxTurns`, path)
      ?? optionalRecordNumber(value["max-turns"], `${field}.max-turns`, path);
    if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns <= 0)) {
      throw new Error(`Skill ${field}.maxTurns must be a positive integer: ${path}`);
    }
    return {
      ...base,
      type,
      prompt: requiredRecordString(value.prompt, `${field}.prompt`, path),
      ...(recordStringList(value.tools, `${field}.tools`, path) === undefined
        ? {}
        : { tools: recordStringList(value.tools, `${field}.tools`, path)! }),
      ...(maxTurns === undefined ? {} : { maxTurns }),
    };
  }
  throw new Error(`Skill ${field}.type must be command, http, prompt, or agent: ${path}`);
}

function parseHooksJson(
  value: string,
  field: string,
  path: string,
): FrontmatterValue {
  try {
    return JSON.parse(value) as FrontmatterValue;
  } catch {
    throw new Error(`Skill ${field} must be a hook object or JSON string: ${path}`);
  }
}

function requiredRecordString(
  value: FrontmatterValue | undefined,
  field: string,
  path: string,
): string {
  const parsed = optionalRecordString(value, field, path);
  if (parsed === undefined) throw new Error(`Skill ${field} is required: ${path}`);
  return parsed;
}

function optionalRecordString(
  value: FrontmatterValue | undefined,
  field: string,
  path: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Skill ${field} must be a non-empty string: ${path}`);
  }
  return value.trim();
}

function optionalRecordBoolean(
  value: FrontmatterValue | undefined,
  field: string,
  path: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Skill ${field} must be true or false: ${path}`);
  return value;
}

function optionalRecordNumber(
  value: FrontmatterValue | undefined,
  field: string,
  path: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Skill ${field} must be a number: ${path}`);
  }
  return value;
}

function recordStringList(
  value: FrontmatterValue | undefined,
  field: string,
  path: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Skill ${field} must be a list of strings: ${path}`);
  }
  return (value as string[]).map((item) => item.trim());
}

function recordStringMap(
  value: FrontmatterValue | undefined,
  field: string,
  path: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Skill ${field} must be an object: ${path}`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`Skill ${field}.${key} must be a string: ${path}`);
    result[key] = entry;
  }
  return result;
}

function isRecord(value: FrontmatterValue | undefined): value is Record<string, FrontmatterValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeFrontmatterKey(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]*:(?:\s+.*|\s*)$/.test(value);
}

function indentation(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function isIgnorableLine(line: string): boolean {
  return !line.trim() || line.trimStart().startsWith("#");
}

function nextMeaningfulLine(lines: string[], start: number): number {
  let index = start;
  while (index < lines.length && isIgnorableLine(lines[index] ?? "")) index += 1;
  return index;
}

function nextNonBlankLine(lines: string[], start: number): number {
  let index = start;
  while (index < lines.length && !(lines[index] ?? "").trim()) index += 1;
  return index;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
