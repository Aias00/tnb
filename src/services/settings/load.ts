import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolve } from "node:path";

import { PERMISSION_MODES, type PermissionMode, type PermissionRules } from "../../core/permissions";
import {
  HOOK_EVENTS,
  type HookHandler,
  type HookEvent,
  type HookMatcher,
  type HooksConfig,
} from "../hooks/runner";
import type { SandboxSettings } from "../sandbox/macos";

export type TnbSettings = {
  provider?: string;
  model?: string;
  fastMode?: boolean;
  autoMemoryEnabled?: boolean;
  autoMemoryDirectory?: string;
  enabledPlugins?: Record<string, boolean>;
  general?: { vimMode?: boolean; editor?: string };
  ui?: { theme?: "magenta" | "cyan" | "blue" | "green" };
  permissions?: PermissionRules & {
    defaultMode?: PermissionMode;
    disableBypassPermissionsMode?: "disable";
  };
  security?: {
    disableYolo?: boolean;
    trustedFolders?: string[];
  };
  tools?: {
    sandbox?: SandboxSettings;
  };
  hooks?: HooksConfig;
  warnings?: string[];
};

export async function loadSettings(options: {
  configDir: string;
  cwd: string;
  additional?: string;
}): Promise<TnbSettings> {
  const userPath = join(options.configDir, "settings.json");
  const projectPaths = [
    join(options.cwd, ".tnb", "settings.json"),
    join(options.cwd, ".tnb", "settings.local.json"),
  ];
  const userSettings = await readSettings(userPath);
  let result: TnbSettings = userSettings ?? {};
  const projectHooksTrusted = userSettings?.security?.trustedFolders?.some(
    (folder) => resolve(folder) === resolve(options.cwd),
  ) === true;
  const warnings: string[] = [];
  for (const path of projectPaths) {
    const settings = await readSettings(path);
    if (!settings) continue;
    if (settings.autoMemoryDirectory !== undefined) {
      warnings.push(`Ignored autoMemoryDirectory from ${path}; this path may only be configured in ${userPath}`);
      delete settings.autoMemoryDirectory;
    }
    if (settings.hooks && !projectHooksTrusted) {
      warnings.push(`Ignored project hooks from ${path}; add ${resolve(options.cwd)} to security.trustedFolders in ${userPath}`);
      const { hooks: _ignoredHooks, ...safeSettings } = settings;
      result = mergeSettings(result, safeSettings);
    } else {
      result = mergeSettings(result, settings);
    }
  }
  if (options.additional !== undefined) {
    result = mergeSettings(result, await loadSettingsInput(options.additional, options.cwd));
  }
  return warnings.length ? { ...result, warnings } : result;
}

export async function loadSettingsInput(input: string, cwd: string): Promise<TnbSettings> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("--settings requires a non-empty file path or JSON object");
  if (trimmed.startsWith("{")) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      throw new Error("Invalid settings JSON: --settings", { cause: error });
    }
    return validateSettings(value, "--settings");
  }
  const path = resolve(cwd, input);
  const settings = await readSettings(path);
  if (!settings) throw new Error(`Settings file not found: ${path}`);
  return settings;
}

async function readSettings(path: string): Promise<TnbSettings | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid settings JSON: ${path}`, { cause: error });
  }
  return validateSettings(value, path);
}

function validateSettings(value: unknown, path: string): TnbSettings {
  const root = requireObject(value, `Settings must be an object: ${path}`);
  const result: TnbSettings = {};
  if (root.provider !== undefined) {
    if (typeof root.provider !== "string" || !root.provider.trim()) throw new Error(`provider must be a non-empty string: ${path}`);
    result.provider = root.provider;
  }
  if (root.model !== undefined) {
    if (typeof root.model !== "string" || !root.model.trim()) throw new Error(`model must be a non-empty string: ${path}`);
    result.model = root.model;
  }
  if (root.fastMode !== undefined) {
    if (typeof root.fastMode !== "boolean") throw new Error(`fastMode must be boolean: ${path}`);
    result.fastMode = root.fastMode;
  }
  if (root.autoMemoryEnabled !== undefined) {
    if (typeof root.autoMemoryEnabled !== "boolean") throw new Error(`autoMemoryEnabled must be boolean: ${path}`);
    result.autoMemoryEnabled = root.autoMemoryEnabled;
  }
  if (root.autoMemoryDirectory !== undefined) {
    if (typeof root.autoMemoryDirectory !== "string" || !root.autoMemoryDirectory.trim()) {
      throw new Error(`autoMemoryDirectory must be a non-empty string: ${path}`);
    }
    result.autoMemoryDirectory = root.autoMemoryDirectory;
  }
  if (root.enabledPlugins !== undefined) {
    const plugins = requireObject(root.enabledPlugins, `enabledPlugins must be an object: ${path}`);
    if (Object.values(plugins).some((value) => typeof value !== "boolean")) {
      throw new Error(`enabledPlugins values must be boolean: ${path}`);
    }
    result.enabledPlugins = plugins as Record<string, boolean>;
  }
  if (root.general !== undefined) {
    const general = requireObject(root.general, `general must be an object: ${path}`);
    const parsed: NonNullable<TnbSettings["general"]> = {};
    if (general.vimMode !== undefined) {
      if (typeof general.vimMode !== "boolean") throw new Error(`general.vimMode must be boolean: ${path}`);
      parsed.vimMode = general.vimMode;
    }
    if (general.editor !== undefined) {
      if (typeof general.editor !== "string" || !general.editor.trim()) throw new Error(`general.editor must be a non-empty string: ${path}`);
      parsed.editor = general.editor.trim();
    }
    result.general = parsed;
  }
  if (root.ui !== undefined) {
    const ui = requireObject(root.ui, `ui must be an object: ${path}`);
    const parsed: NonNullable<TnbSettings["ui"]> = {};
    if (ui.theme !== undefined) {
      if (ui.theme !== "magenta" && ui.theme !== "cyan" && ui.theme !== "blue" && ui.theme !== "green") {
        throw new Error(`ui.theme must be magenta, cyan, blue, or green: ${path}`);
      }
      parsed.theme = ui.theme;
    }
    result.ui = parsed;
  }
  if (root.permissions !== undefined) {
    const permissions = requireObject(root.permissions, `permissions must be an object: ${path}`);
    const parsed: NonNullable<TnbSettings["permissions"]> = {};
    for (const behavior of ["allow", "deny", "ask"] as const) {
      if (permissions[behavior] !== undefined) {
        parsed[behavior] = stringArray(permissions[behavior], `permissions.${behavior}`, path);
      }
    }
    if (permissions.defaultMode !== undefined) {
      if (
        typeof permissions.defaultMode !== "string" ||
        !(PERMISSION_MODES as readonly string[]).includes(permissions.defaultMode)
      ) {
        throw new Error(`Invalid permissions.defaultMode: ${path}`);
      } else {
        parsed.defaultMode = permissions.defaultMode as PermissionMode;
      }
    }
    if (permissions.disableBypassPermissionsMode !== undefined) {
      if (permissions.disableBypassPermissionsMode !== "disable") {
        throw new Error(`Invalid permissions.disableBypassPermissionsMode: ${path}`);
      }
      parsed.disableBypassPermissionsMode = "disable";
    }
    result.permissions = parsed;
  }
  if (root.security !== undefined) {
    const security = requireObject(root.security, `security must be an object: ${path}`);
    const parsed: NonNullable<TnbSettings["security"]> = {};
    if (security.disableYolo !== undefined) {
      if (typeof security.disableYolo !== "boolean") {
        throw new Error(`Invalid security.disableYolo: ${path}`);
      }
      parsed.disableYolo = security.disableYolo;
    }
    if (security.trustedFolders !== undefined) {
      parsed.trustedFolders = stringArray(
        security.trustedFolders,
        "security.trustedFolders",
        path,
      );
    }
    result.security = parsed;
  }
  if (root.tools !== undefined) {
    const tools = requireObject(root.tools, `tools must be an object: ${path}`);
    if (tools.sandbox !== undefined) {
      result.tools = { sandbox: parseSandboxSettings(tools.sandbox, path) };
    }
  }
  if (root.hooks !== undefined) {
    result.hooks = parseHooks(root.hooks, path);
  }
  return result;
}

function mergeSettings(
  earlier: TnbSettings,
  later: TnbSettings,
): TnbSettings {
  const permissions = mergePermissions(earlier.permissions, later.permissions);
  const security =
    earlier.security || later.security
      ? {
          ...earlier.security,
          ...later.security,
          ...(earlier.security?.trustedFolders || later.security?.trustedFolders
            ? {
                trustedFolders: unique([
                  ...(earlier.security?.trustedFolders ?? []),
                  ...(later.security?.trustedFolders ?? []),
                ]),
              }
            : {}),
        }
      : undefined;
  const tools = earlier.tools || later.tools
    ? {
        ...earlier.tools,
        ...later.tools,
        ...(isSandboxObject(earlier.tools?.sandbox) && isSandboxObject(later.tools?.sandbox)
          ? { sandbox: { ...earlier.tools.sandbox, ...later.tools.sandbox } }
          : {}),
      }
    : undefined;
  return {
    ...(later.provider ?? earlier.provider ? { provider: later.provider ?? earlier.provider } : {}),
    ...(later.model ?? earlier.model ? { model: later.model ?? earlier.model } : {}),
    ...((later.fastMode ?? earlier.fastMode) !== undefined
      ? { fastMode: later.fastMode ?? earlier.fastMode }
      : {}),
    ...((later.autoMemoryEnabled ?? earlier.autoMemoryEnabled) !== undefined
      ? { autoMemoryEnabled: later.autoMemoryEnabled ?? earlier.autoMemoryEnabled }
      : {}),
    ...(later.autoMemoryDirectory ?? earlier.autoMemoryDirectory
      ? { autoMemoryDirectory: later.autoMemoryDirectory ?? earlier.autoMemoryDirectory }
      : {}),
    ...(earlier.enabledPlugins || later.enabledPlugins
      ? { enabledPlugins: { ...earlier.enabledPlugins, ...later.enabledPlugins } }
      : {}),
    ...(earlier.general || later.general ? { general: { ...earlier.general, ...later.general } } : {}),
    ...(earlier.ui || later.ui ? { ui: { ...earlier.ui, ...later.ui } } : {}),
    ...(permissions ? { permissions } : {}),
    ...(security ? { security } : {}),
    ...(tools ? { tools } : {}),
    ...(earlier.hooks || later.hooks
      ? { hooks: mergeHooks(earlier.hooks, later.hooks) }
      : {}),
    ...(earlier.warnings || later.warnings
      ? { warnings: [...(earlier.warnings ?? []), ...(later.warnings ?? [])] }
      : {}),
  };
}

function parseSandboxSettings(value: unknown, path: string): SandboxSettings {
  if (typeof value === "boolean") return value;
  const sandbox = requireObject(value, `tools.sandbox must be a boolean or object: ${path}`);
  const result: Exclude<SandboxSettings, boolean> = {};
  if (sandbox.enabled !== undefined) {
    if (typeof sandbox.enabled !== "boolean") throw new Error(`tools.sandbox.enabled must be boolean: ${path}`);
    result.enabled = sandbox.enabled;
  }
  if (sandbox.command !== undefined) {
    if (!["auto", "sandbox-exec", "bwrap", "powershell", "appcontainer"].includes(String(sandbox.command))) {
      throw new Error(`tools.sandbox.command must be auto, sandbox-exec, bwrap, powershell, or appcontainer: ${path}`);
    }
    result.command = sandbox.command as NonNullable<Exclude<SandboxSettings, boolean>["command"]>;
  }
  if (sandbox.allowedPaths !== undefined) {
    result.allowedPaths = stringArray(sandbox.allowedPaths, "tools.sandbox.allowedPaths", path);
  }
  if (sandbox.networkAccess !== undefined) {
    if (typeof sandbox.networkAccess !== "boolean") throw new Error(`tools.sandbox.networkAccess must be boolean: ${path}`);
    result.networkAccess = sandbox.networkAccess;
  }
  if (sandbox.profile !== undefined) {
    if (sandbox.profile !== "permissive" && sandbox.profile !== "restrictive" && sandbox.profile !== "strict") {
      throw new Error(`tools.sandbox.profile must be permissive, restrictive, or strict: ${path}`);
    }
    result.profile = sandbox.profile;
  }
  if (sandbox.network !== undefined) {
    if (sandbox.network !== "open" && sandbox.network !== "proxied") {
      throw new Error(`tools.sandbox.network must be open or proxied: ${path}`);
    }
    result.network = sandbox.network;
  }
  return result;
}

function isSandboxObject(value: SandboxSettings | undefined): value is Exclude<SandboxSettings, boolean> {
  return typeof value === "object" && value !== null;
}

function parseHooks(value: unknown, path: string): HooksConfig {
  const root = requireObject(value, `hooks must be an object: ${path}`);
  const result: HooksConfig = {};
  for (const [eventName, groupsValue] of Object.entries(root)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(eventName)) {
      throw new Error(`Unsupported hook event '${eventName}': ${path}`);
    }
    if (!Array.isArray(groupsValue)) throw new Error(`hooks.${eventName} must be an array: ${path}`);
    const groups = groupsValue.map((groupValue, index) =>
      parseHookMatcher(groupValue, `${path}: hooks.${eventName}[${index}]`)
    );
    result[eventName as HookEvent] = groups;
  }
  return result;
}

function parseHookMatcher(value: unknown, location: string): HookMatcher {
  const group = requireObject(value, `${location} must be an object`);
  if (group.matcher !== undefined && typeof group.matcher !== "string") {
    throw new Error(`${location}.matcher must be a string`);
  }
  if (!Array.isArray(group.hooks) || group.hooks.length === 0) {
    throw new Error(`${location}.hooks must be a non-empty array`);
  }
  if (group.sequential !== undefined && typeof group.sequential !== "boolean") throw new Error(`${location}.sequential must be boolean`);
  if (group.async !== undefined && typeof group.async !== "boolean") throw new Error(`${location}.async must be boolean`);
  const hooks = group.hooks.map((hook, index) => parseHookCommand(hook, `${location}.hooks[${index}]`));
  return {
    ...(typeof group.matcher === "string" && group.matcher ? { matcher: group.matcher } : {}),
    hooks,
    ...(group.sequential === true ? { sequential: true } : {}),
    ...(group.async === true ? { async: true } : {}),
  };
}

function parseHookCommand(value: unknown, location: string): HookHandler {
  if (typeof value === "string" && value.trim()) {
    return { type: "command", command: value.trim() };
  }
  const hook = requireObject(value, `${location} must be a hook string or object`);
  if (!['command', 'http', 'prompt', 'agent'].includes(String(hook.type))) {
    throw new Error(`${location}.type must be command, http, prompt, or agent`);
  }
  if (hook.timeout !== undefined && (typeof hook.timeout !== "number" || !Number.isFinite(hook.timeout) || hook.timeout <= 0)) {
    throw new Error(`${location}.timeout must be a positive number of seconds`);
  }
  if (hook.async !== undefined && typeof hook.async !== "boolean") throw new Error(`${location}.async must be boolean`);
  const common = {
    ...(typeof hook.timeout === "number" ? { timeout: hook.timeout } : {}),
    ...(typeof hook.name === "string" && hook.name.trim() ? { name: hook.name.trim() } : {}),
    ...(typeof hook.if === "string" && hook.if.trim() ? { if: hook.if.trim() } : {}),
    ...(hook.async === true ? { async: true } : {}),
  };
  if (hook.type === "command") {
    if (typeof hook.command !== "string" || !hook.command.trim()) throw new Error(`${location}.command must be a non-empty string`);
    if (hook.args !== undefined && (!Array.isArray(hook.args) || hook.args.some((arg) => typeof arg !== "string"))) {
      throw new Error(`${location}.args must be an array of strings`);
    }
    return { type: "command", command: hook.command, ...(hook.args ? { args: hook.args as string[] } : {}), ...common };
  }
  if (hook.type === "http") {
    if (typeof hook.url !== "string" || !/^https?:\/\//.test(hook.url)) throw new Error(`${location}.url must be an HTTP(S) URL`);
    const headers = hook.headers === undefined ? undefined : requireObject(hook.headers, `${location}.headers must be an object`);
    if (headers && Object.values(headers).some((entry) => typeof entry !== "string")) throw new Error(`${location}.headers values must be strings`);
    return { type: "http", url: hook.url, ...(headers ? { headers: headers as Record<string, string> } : {}), ...common };
  }
  if (typeof hook.prompt !== "string" || !hook.prompt.trim()) throw new Error(`${location}.prompt must be a non-empty string`);
  if (hook.type === "prompt") return { type: "prompt", prompt: hook.prompt, ...common };
  if (hook.tools !== undefined && (!Array.isArray(hook.tools) || hook.tools.some((tool) => typeof tool !== "string"))) {
    throw new Error(`${location}.tools must be an array of strings`);
  }
  if (hook.maxTurns !== undefined && (!Number.isInteger(hook.maxTurns) || (hook.maxTurns as number) < 1)) {
    throw new Error(`${location}.maxTurns must be a positive integer`);
  }
  return {
    type: "agent",
    prompt: hook.prompt,
    ...(hook.tools ? { tools: hook.tools as string[] } : {}),
    ...(typeof hook.maxTurns === "number" ? { maxTurns: hook.maxTurns } : {}),
    ...common,
  };
}

function mergeHooks(earlier: HooksConfig | undefined, later: HooksConfig | undefined): HooksConfig {
  const result: HooksConfig = {};
  for (const event of HOOK_EVENTS) {
    const groups = [...(earlier?.[event] ?? []), ...(later?.[event] ?? [])];
    if (groups.length) result[event] = groups;
  }
  return result;
}

function mergePermissions(
  earlier: TnbSettings["permissions"],
  later: TnbSettings["permissions"],
): TnbSettings["permissions"] {
  if (!earlier && !later) return undefined;
  return {
    ...earlier,
    ...later,
    ...mergeRuleArray("allow", earlier, later),
    ...mergeRuleArray("deny", earlier, later),
    ...mergeRuleArray("ask", earlier, later),
  };
}

function mergeRuleArray(
  behavior: "allow" | "deny" | "ask",
  earlier: TnbSettings["permissions"],
  later: TnbSettings["permissions"],
): Partial<PermissionRules> {
  if (!earlier?.[behavior] && !later?.[behavior]) return {};
  return { [behavior]: unique([...(earlier?.[behavior] ?? []), ...(later?.[behavior] ?? [])]) };
}

function stringArray(value: unknown, field: string, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${field} must be an array of non-empty strings: ${path}`);
  }
  return value;
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
