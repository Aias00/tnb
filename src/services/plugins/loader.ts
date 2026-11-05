import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { gte, lte, valid } from "semver";

import type { ExtensionDeclaration, ContributionReference, ExtensionKind } from "../../agent/extensions";
import type { ToolAccess } from "../../core/tool";
import packageJson from "../../../package.json";
import type { HooksConfig, HookEvent } from "../hooks/runner";
import { HOOK_EVENTS } from "../hooks/runner";
import { loadMcpConfig, type McpConfig } from "../mcp/config";
import { computePluginTreeSha256, pluginTrustState, type PluginTrustState } from "./trust";
import { isPluginActive, resolvePluginPolicy, type PluginPolicy } from "./policy";
import { pluginHttpTarget } from "./network";
import { parsePluginDataDeclaration } from "../../agent/plugin-data";

const BUILT_IN_PLUGIN_TOOLS = new Map<string, {
  toolName: string;
  description: string;
  access: ToolAccess;
  security: PluginToolSecurity;
  lifecycle: PluginExternalToolLifecycle;
}>([
  ["builtin:security_scan", {
    toolName: "security_scan",
    description: "Run the enabled local SAST rules against workspace paths without executing scanned files.",
    access: "read",
    security: {
      access: "read",
      workspace: "read",
      network: "none",
      shell: false,
      approval: "inherit",
    },
    lifecycle: {
      transport: "in_process",
      start: "lazy",
      reload: "runtime",
    },
  }],
]);

const DEFAULT_PLUGIN_LIFECYCLE: LoadedPlugin["lifecycle"] = {
  activation: "auto",
  start: "lazy",
  reload: "runtime",
  state: "ephemeral",
  events: [],
};

const DEFAULT_EXTERNAL_TOOL_SECURITY: PluginToolSecurity = {
  access: "execute",
  workspace: "none",
  network: "none",
  shell: false,
  approval: "inherit",
};

const DEFAULT_EXTERNAL_TOOL_LIFECYCLE: PluginExternalToolLifecycle = {
  transport: "oneshot",
  start: "lazy",
  reload: "runtime",
};

export type PluginCompatibility = {
  hosts?: string[];
  minTnbVersion?: string;
  maxTnbVersion?: string;
  testedTnbVersions?: string[];
};

export type PluginDocumentation = {
  overview?: string;
  whenToUse?: string;
  lifecycle?: string;
  contributionNotes?: string[];
  examples?: string[];
  resources?: string[];
};

export type PluginToolSecurity = {
  access: ToolAccess;
  workspace: "none" | "read" | "write";
  network: "none" | "loopback" | "egress";
  shell: boolean;
  approval: "inherit" | "always";
};

export type PluginExternalToolLifecycle = {
  transport: "stdio" | "oneshot" | "http" | "in_process";
  start: "lazy" | "eager";
  reload: "runtime" | "session" | "restart";
};

export type BuiltInPluginToolContribution = {
  id: string;
  type: "builtin";
  toolName: string;
  description: string;
  access: ToolAccess;
  security: PluginToolSecurity;
  lifecycle: PluginExternalToolLifecycle;
};

export type ExternalPluginToolContribution = {
  id: string;
  type: "external";
  description: string;
  command: string;
  args: string[];
  inputSchema?: Record<string, unknown>;
  inputSchemaPath?: string;
  security: PluginToolSecurity;
  lifecycle: PluginExternalToolLifecycle;
};

export type PluginToolContribution = BuiltInPluginToolContribution | ExternalPluginToolContribution;
export type PluginAdapterContribution = { id: string; version: string; entry: string };

export type LoadedPlugin = {
  name: string;
  manifestVersion: number;
  manifestPath?: string;
  version?: string;
  description?: string;
  apiVersion?: string;
  compatibility?: PluginCompatibility;
  documentation?: PluginDocumentation;
  lifecycle: {
    activation: "auto" | "manual";
    start: "lazy" | "eager";
    reload: "runtime" | "session" | "restart";
    state: "ephemeral" | "workspace" | "user";
    events: string[];
  };
  root: string;
  source: "user" | "project";
  explicitlyEnabled: boolean;
  active: boolean;
  policy?: PluginPolicy;
  fingerprint?: string;
  trust: PluginTrustState | "not-required";
  skillsDir: string;
  agentsDir: string;
  commandsDir: string;
  hooksPath?: string;
  mcpPath?: string;
  tools?: string[];
  toolContributions: PluginToolContribution[];
  adapterContributions?: PluginAdapterContribution[];
  extensionContributions?: ExtensionDeclaration[];
  contributionSummary: {
    skills: boolean;
    agents: boolean;
    commands: boolean;
    hooks: boolean;
    mcpServers: boolean;
    builtInTools: string[];
    externalTools: string[];
    adapters?: string[];
    applications?: string[];
    interfaces?: string[];
    channels?: string[];
  };
};

export type PluginLoadResult = {
  plugins: LoadedPlugin[];
  errors: Array<{ path: string; error: string }>;
};

export async function loadPlugins(
  roots: Array<{ directory: string; source: LoadedPlugin["source"] }>,
  enabled: Record<string, boolean> = {},
  options: { trustStorePath?: string; includeDisabled?: boolean; blockedFingerprints?: readonly string[] } = {},
): Promise<PluginLoadResult> {
  const plugins = new Map<string, LoadedPlugin>();
  const errors: PluginLoadResult["errors"] = [];
  for (const source of roots) {
    let entries;
    try {
      entries = await readdir(source.directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (isInternalPluginDirectory(entry.name)) continue;
      const candidate = join(source.directory, entry.name);
      try {
        const root = await realpath(candidate);
        const manifest = await readManifest(root, entry.name);
        const key = manifest.name.toLowerCase();
        const disabled = enabled[manifest.name] === false || enabled[key] === false;
        if (disabled && !options.includeDisabled) continue;
        const explicitlyEnabled = enabled[manifest.name] === true || enabled[key] === true;
        if (plugins.has(key)) continue;
        const skillsDir = join(root, "skills");
        const agentsDir = join(root, "agents");
        const commandsDir = join(root, "commands");
        const hooksPath = manifest.hooks ? contributionPath(root, manifest.hooks, "hooks") : undefined;
        const mcpPath = manifest.mcpServers ? contributionPath(root, manifest.mcpServers, "mcpServers") : undefined;
        const fingerprint = options.trustStorePath || options.blockedFingerprints?.length ? await computePluginTreeSha256(root) : undefined;
        const trust = options.trustStorePath && fingerprint
          ? await pluginTrustState(options.trustStorePath, root, fingerprint)
          : "not-required";
        const policy = resolvePluginPolicy({ ...manifest, fingerprint, trust }, { enabled, blockedFingerprints: options.blockedFingerprints });
        plugins.set(key, {
          ...manifest,
          root,
          source: source.source,
          explicitlyEnabled,
          active: policy.status === "ready",
          policy,
          ...(fingerprint ? { fingerprint } : {}),
          trust,
          skillsDir,
          agentsDir,
          commandsDir,
          ...(hooksPath ? { hooksPath } : {}),
          ...(mcpPath ? { mcpPath } : {}),
          ...(manifest.tools?.length ? { tools: manifest.tools } : {}),
          contributionSummary: {
            skills: await directoryExists(skillsDir),
            agents: await directoryExists(agentsDir),
            commands: await directoryExists(commandsDir),
            hooks: Boolean(hooksPath),
            mcpServers: Boolean(mcpPath),
            builtInTools: manifest.toolContributions
              .filter((tool): tool is BuiltInPluginToolContribution => tool.type === "builtin")
              .map((tool) => tool.id),
            externalTools: manifest.toolContributions
              .filter((tool): tool is ExternalPluginToolContribution => tool.type === "external")
              .map((tool) => tool.id),
            ...Object.fromEntries((["application", "interface", "channel"] as const).flatMap(kind => {
              const values = manifest.extensionContributions?.filter(item => item.kind === kind).map(item => `${item.id}@${item.version}`) ?? [];
              return values.length ? [[`${kind}s`, values]] : [];
            })),
            ...(manifest.adapterContributions?.length ? { adapters: manifest.adapterContributions.map(adapter => `${adapter.id}@${adapter.version}`) } : {}),
          },
        });
      } catch (error) {
        errors.push({ path: candidate, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { plugins: [...plugins.values()], errors };
}

function isInternalPluginDirectory(name: string): boolean {
  return name === ".runtime" || name === ".removed" || name.startsWith(".install-") || name.startsWith(".install-stage-") ||
    name.startsWith(".update-stage-") || name.startsWith(".update-backup-");
}

async function readManifest(root: string, fallbackName: string): Promise<{
  name: string;
  manifestVersion: number;
  manifestPath?: string;
  version?: string;
  description?: string;
  apiVersion?: string;
  compatibility?: PluginCompatibility;
  documentation?: PluginDocumentation;
  lifecycle: LoadedPlugin["lifecycle"];
  hooks?: string;
  mcpServers?: string;
  tools?: string[];
  toolContributions: PluginToolContribution[];
  adapterContributions?: PluginAdapterContribution[];
  extensionContributions?: ExtensionDeclaration[];
}> {
  const candidates = [join(root, ".tnb-plugin", "plugin.json"), join(root, "plugin.json")];
  let value: unknown;
  let manifestPath: string | undefined;
  for (const path of candidates) {
    try {
      value = JSON.parse(await readFile(path, "utf8"));
      manifestPath = path;
      break;
    } catch (error) {
      if (!isMissing(error)) throw new Error(`Invalid plugin manifest: ${path}`, { cause: error });
    }
  }
  if (value === undefined) value = { name: fallbackName };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Plugin manifest must be an object: ${manifestPath ?? root}`);
  }
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error(`Invalid plugin name: ${name || "(missing)"}`);
  if (["adapters", "applications", "interfaces", "channels"].some(key => record[key] !== undefined)) throw new Error("Executable contributions must be declared inside contributes");
  const contributes = optionalObject(record.contributes, "contributes", manifestPath ?? root);
  const version = optionalString(record.version, "version", manifestPath ?? root);
  const description = optionalString(record.description, "description", manifestPath ?? root);
  const manifestVersion = optionalPositiveInteger(record.manifestVersion, "manifestVersion", manifestPath ?? root) ?? 1;
  const apiVersion = optionalString(record.apiVersion, "apiVersion", manifestPath ?? root);
  const compatibility = optionalCompatibility(record.compatibility, manifestPath ?? root);
  validatePluginCompatibility({ manifestVersion, version, apiVersion, compatibility }, manifestPath ?? root);
  const documentation = optionalDocumentation(record.documentation, manifestPath ?? root, root);
  const lifecycle = optionalLifecycle(record.lifecycle, manifestPath ?? root) ?? DEFAULT_PLUGIN_LIFECYCLE;
  const hooks = optionalString(
    contributionValue(record, contributes, "hooks", manifestPath ?? root),
    "hooks",
    manifestPath ?? root,
  );
  const mcpServers = optionalString(
    contributionValue(record, contributes, "mcpServers", manifestPath ?? root),
    "mcpServers",
    manifestPath ?? root,
  );
  const toolContributions = optionalToolContributions(
    contributionValue(record, contributes, "tools", manifestPath ?? root),
    manifestPath ?? root,
    root,
  ) ?? [];
  const tools = toolContributions
    .filter((tool): tool is BuiltInPluginToolContribution => tool.type === "builtin")
    .map((tool) => tool.id);
  if (contributes && Object.keys(contributes).some(key => !["adapters", "applications", "interfaces", "channels", "tools", "hooks", "mcpServers", "skills", "agents", "commands"].includes(key))) throw new Error("Unknown plugin contribution kind");
  const extensionContributions = (["application", "interface", "channel"] as const).flatMap(kind => optionalExtensionContributions(contributes?.[`${kind}s`], kind, manifestPath ?? root, root));
  const adapterContributions = optionalAdapterContributions(contributes?.adapters, manifestPath ?? root, root);
  if ((adapterContributions.length || extensionContributions.length) && (manifestVersion !== 2 || !["tnb.plugin/v1", "tnb.host-plugin/v1"].includes(apiVersion ?? "") || !version)) throw new Error("Executable plugins require manifestVersion 2, a supported API and a package version");
  if (extensionContributions.length && apiVersion !== "tnb.host-plugin/v1") throw new Error("Applications, interfaces and channels require apiVersion tnb.host-plugin/v1");
  return {
    name,
    manifestVersion,
    ...(manifestPath ? { manifestPath } : {}),
    ...(version ? { version } : {}),
    ...(description ? { description } : {}),
    ...(apiVersion ? { apiVersion } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(documentation ? { documentation } : {}),
    lifecycle: adapterContributions.length || extensionContributions.length ? { ...lifecycle, reload: "restart" } : lifecycle,
    ...(hooks ? { hooks } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(tools?.length ? { tools } : {}),
    toolContributions,
    ...(adapterContributions.length ? { adapterContributions } : {}),
    ...(extensionContributions.length ? { extensionContributions } : {}),
  };
}

function optionalAdapterContributions(value: unknown, path: string, root: string): PluginAdapterContribution[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error(`Plugin contributes.adapters must contain 1..32 entries: ${path}`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Invalid adapter contribution: ${path}`);
    const id = requiredIdentifier(item.id, `adapters[${index}].id`, path);
    const version = requiredString(item.version, `adapters[${index}].version`, path);
    if (version.length > 128 || seen.has(`${id}@${version}`)) throw new Error(`Duplicate adapter contribution: ${path}`);
    seen.add(`${id}@${version}`);
    const entry = requiredString(item.entry, `adapters[${index}].entry`, path);
    contributionPath(root, entry, "adapters.entry");
    if (!entry.endsWith(".mjs")) throw new Error(`Adapter entries must be bundled .mjs modules: ${path}`);
    return { id, version, entry };
  });
}

function optionalExtensionContributions(value: unknown, kind: ExtensionKind, path: string, root: string): ExtensionDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error(`Plugin contributes.${kind}s must contain 1..32 entries: ${path}`);
  const seen = new Set<string>();
  return value.map(item => {
    if (!isRecord(item) || Object.keys(item).some(key => !["id", "version", "entry", "services", "requires", "configuration", "state"].includes(key))) throw new Error(`Invalid ${kind} contribution: ${path}`);
    const id = requiredIdentifier(item.id, `${kind}.id`, path), version = requiredString(item.version, `${kind}.version`, path);
    if (version.length > 128 || seen.has(`${id}@${version}`)) throw new Error(`Duplicate ${kind} contribution: ${path}`);
    seen.add(`${id}@${version}`);
    const entry = requiredString(item.entry, `${kind}.entry`, path); contributionPath(root, entry, `${kind}.entry`);
    if (!entry.endsWith(".mjs")) throw new Error("Executable plugin entries must be bundled .mjs modules");
    const services = optionalStringArray(item.services, `${kind}.services`, path) ?? [];
    if (services.length > 32 || new Set(services).size !== services.length || services.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9.:/_-]{0,127}$/.test(name))) throw new Error("Invalid or duplicate plugin service declaration");
    if (item.requires !== undefined && (!Array.isArray(item.requires) || item.requires.length > 32)) throw new Error("Invalid plugin dependencies");
    const requires: ContributionReference[] = ((item.requires as unknown[] | undefined) ?? []).map(raw => {
      if (!isRecord(raw) || Object.keys(raw).some(key => !["kind", "id", "version"].includes(key)) || !["adapter", "application", "interface", "channel"].includes(String(raw.kind))) throw new Error("Invalid plugin dependency");
      return { kind: raw.kind as ContributionReference["kind"], id: requiredIdentifier(raw.id, "dependency.id", path), version: requiredString(raw.version, "dependency.version", path) };
    });
    if (new Set(requires.map(ref => JSON.stringify(ref))).size !== requires.length) throw new Error("Duplicate plugin dependency");
    return { kind, id, version, entry, services, requires, ...parsePluginDataDeclaration(item, kind) };
  });
}

function validatePluginCompatibility(input: {
  manifestVersion: number;
  version?: string;
  apiVersion?: string;
  compatibility?: PluginCompatibility;
}, path: string): void {
  if (input.manifestVersion > 2) throw new Error(`Unsupported plugin manifestVersion ${input.manifestVersion}: ${path}`);
  if (input.version && !valid(input.version)) throw new Error(`Plugin version must be semantic version text: ${path}`);
  if (input.apiVersion && !["tnb.plugin/v1", "tnb.host-plugin/v1"].includes(input.apiVersion)) {
    throw new Error(`Unsupported plugin apiVersion ${input.apiVersion}: ${path}`);
  }
  const compatibility = input.compatibility;
  if (compatibility?.hosts?.length && !compatibility.hosts.includes("tnb")) {
    throw new Error(`Plugin does not declare tnb as a compatible host: ${path}`);
  }
  if (compatibility?.minTnbVersion) {
    if (!valid(compatibility.minTnbVersion)) throw new Error(`Plugin compatibility.minTnbVersion must be semantic version text: ${path}`);
    if (!gte(packageJson.version, compatibility.minTnbVersion)) {
      throw new Error(`Plugin requires tnb >= ${compatibility.minTnbVersion}, current version is ${packageJson.version}: ${path}`);
    }
  }
  if (compatibility?.maxTnbVersion) {
    if (!valid(compatibility.maxTnbVersion)) throw new Error(`Plugin compatibility.maxTnbVersion must be semantic version text: ${path}`);
    if (!lte(packageJson.version, compatibility.maxTnbVersion)) {
      throw new Error(`Plugin requires tnb <= ${compatibility.maxTnbVersion}, current version is ${packageJson.version}: ${path}`);
    }
  }
}

function optionalToolContributions(value: unknown, path: string, root: string): PluginToolContribution[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Plugin tools must be an array: ${path}`);
  const contributions = value.map((item, index) => {
    if (typeof item === "string" && item.trim()) return builtInToolContribution(item.trim(), path);
    if (isRecord(item)) return externalToolContribution(item, path, root, index);
    throw new Error(`Plugin tools entries must be non-empty strings or objects: ${path}`);
  });
  const seen = new Set<string>();
  for (const contribution of contributions) {
    const key = contribution.id.toLowerCase();
    if (seen.has(key)) throw new Error(`Plugin tools contain duplicate contribution ${contribution.id}: ${path}`);
    seen.add(key);
  }
  return contributions;
}

function builtInToolContribution(id: string, path: string): BuiltInPluginToolContribution {
  const definition = BUILT_IN_PLUGIN_TOOLS.get(id);
  if (!definition) throw new Error(`Plugin tools contain unsupported contribution ${id}: ${path}`);
  return {
    id,
    type: "builtin",
    toolName: definition.toolName,
    description: definition.description,
    access: definition.access,
    security: definition.security,
    lifecycle: definition.lifecycle,
  };
}

function externalToolContribution(
  value: Record<string, unknown>,
  path: string,
  root: string,
  index: number,
): ExternalPluginToolContribution {
  const type = optionalString(value.type, `tools[${index}].type`, path) ?? "external";
  if (type !== "external") throw new Error(`Plugin tools[${index}].type must be "external": ${path}`);
  const id = requiredIdentifier(value.id, `tools[${index}].id`, path);
  const description = requiredString(value.description, `tools[${index}].description`, path);
  const lifecycle = optionalExternalToolLifecycle(value.lifecycle, path, index) ?? DEFAULT_EXTERNAL_TOOL_LIFECYCLE;
  if (lifecycle.transport === "in_process") throw new Error(`Plugin external tools[${index}] cannot use in_process transport: ${path}`);
  const commandValue = requiredString(value.command, `tools[${index}].command`, path);
  const command = lifecycle.transport === "http"
    ? validatedHttpUrl(commandValue, `tools[${index}].command`, path)
    : contributionPath(root, commandValue, `tools[${index}].command`);
  const args = optionalStringArray(value.args, `tools[${index}].args`, path) ?? [];
  const inputSchema = optionalSchema(value.inputSchema, `tools[${index}].inputSchema`, path);
  const security = optionalExternalToolSecurity(value.security, path, index) ?? DEFAULT_EXTERNAL_TOOL_SECURITY;
  if (lifecycle.transport === "http") {
    pluginHttpTarget(command, security.network);
    if (args.length) throw new Error(`Plugin HTTP tools[${index}] cannot use command args: ${path}`);
  }
  return {
    id,
    type: "external",
    description,
    command,
    args,
    ...(typeof inputSchema === "string"
      ? { inputSchemaPath: contributionPath(root, inputSchema, `tools[${index}].inputSchema`) }
      : inputSchema
        ? { inputSchema }
        : {}),
    lifecycle,
    security,
  };
}

function validatedHttpUrl(value: string, field: string, path: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Plugin ${field} must be an absolute HTTP URL: ${path}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Plugin ${field} must use http or https: ${path}`);
  }
  return url.toString();
}

function optionalSchema(value: unknown, field: string, path: string): Record<string, unknown> | string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (!value.trim()) throw new Error(`Plugin ${field} must be a non-empty string or object: ${path}`);
    return value.trim();
  }
  if (!isRecord(value)) throw new Error(`Plugin ${field} must be a non-empty string or object: ${path}`);
  return value;
}

function optionalExternalToolLifecycle(
  value: unknown,
  path: string,
  index: number,
): PluginExternalToolLifecycle | undefined {
  const record = optionalObject(value, `tools[${index}].lifecycle`, path);
  if (!record) return undefined;
  return {
    transport: enumValue(
      record.transport,
      `tools[${index}].lifecycle.transport`,
      path,
      ["stdio", "oneshot", "http", "in_process"] as const,
    ) ?? DEFAULT_EXTERNAL_TOOL_LIFECYCLE.transport,
    start: enumValue(
      record.start,
      `tools[${index}].lifecycle.start`,
      path,
      ["lazy", "eager"] as const,
    ) ?? DEFAULT_EXTERNAL_TOOL_LIFECYCLE.start,
    reload: enumValue(
      record.reload,
      `tools[${index}].lifecycle.reload`,
      path,
      ["runtime", "session", "restart"] as const,
    ) ?? DEFAULT_EXTERNAL_TOOL_LIFECYCLE.reload,
  };
}

function optionalExternalToolSecurity(
  value: unknown,
  path: string,
  index: number,
): PluginToolSecurity | undefined {
  const record = optionalObject(value, `tools[${index}].security`, path);
  if (!record) return undefined;
  return {
    access: enumValue(
      record.access,
      `tools[${index}].security.access`,
      path,
      ["read", "write", "execute", "network", "unknown"] as const,
    ) ?? DEFAULT_EXTERNAL_TOOL_SECURITY.access,
    workspace: enumValue(
      record.workspace,
      `tools[${index}].security.workspace`,
      path,
      ["none", "read", "write"] as const,
    ) ?? DEFAULT_EXTERNAL_TOOL_SECURITY.workspace,
    network: enumValue(
      record.network,
      `tools[${index}].security.network`,
      path,
      ["none", "loopback", "egress"] as const,
    ) ?? DEFAULT_EXTERNAL_TOOL_SECURITY.network,
    shell: optionalBoolean(record.shell, `tools[${index}].security.shell`, path) ?? DEFAULT_EXTERNAL_TOOL_SECURITY.shell,
    approval: enumValue(
      record.approval,
      `tools[${index}].security.approval`,
      path,
      ["inherit", "always"] as const,
    ) ?? DEFAULT_EXTERNAL_TOOL_SECURITY.approval,
  };
}

function optionalCompatibility(value: unknown, path: string): PluginCompatibility | undefined {
  const record = optionalObject(value, "compatibility", path);
  if (!record) return undefined;
  const hosts = optionalStringArray(record.hosts, "compatibility.hosts", path);
  const minTnbVersion = optionalString(record.minTnbVersion, "compatibility.minTnbVersion", path);
  const maxTnbVersion = optionalString(record.maxTnbVersion, "compatibility.maxTnbVersion", path);
  const testedTnbVersions = optionalStringArray(record.testedTnbVersions, "compatibility.testedTnbVersions", path);
  const compatibility: PluginCompatibility = {};
  if (hosts?.length) compatibility.hosts = hosts;
  if (minTnbVersion) compatibility.minTnbVersion = minTnbVersion;
  if (maxTnbVersion) compatibility.maxTnbVersion = maxTnbVersion;
  if (testedTnbVersions?.length) compatibility.testedTnbVersions = testedTnbVersions;
  return compatibility;
}

function optionalDocumentation(value: unknown, path: string, root: string): PluginDocumentation | undefined {
  const record = optionalObject(value, "documentation", path);
  if (!record) return undefined;
  const overview = optionalString(record.overview, "documentation.overview", path);
  const whenToUse = optionalString(record.whenToUse, "documentation.whenToUse", path);
  const lifecycle = optionalString(record.lifecycle, "documentation.lifecycle", path);
  const contributionNotes = optionalStringArray(record.contributionNotes, "documentation.contributionNotes", path);
  const examples = optionalStringArray(record.examples, "documentation.examples", path);
  const resources = optionalStringArray(record.resources, "documentation.resources", path)
    ?.map((resource) => contributionPath(root, resource, "documentation.resources"));
  const documentation: PluginDocumentation = {};
  if (overview) documentation.overview = overview;
  if (whenToUse) documentation.whenToUse = whenToUse;
  if (lifecycle) documentation.lifecycle = lifecycle;
  if (contributionNotes?.length) documentation.contributionNotes = contributionNotes;
  if (examples?.length) documentation.examples = examples;
  if (resources?.length) documentation.resources = resources;
  return Object.keys(documentation).length ? documentation : undefined;
}

function optionalLifecycle(value: unknown, path: string): LoadedPlugin["lifecycle"] | undefined {
  const record = optionalObject(value, "lifecycle", path);
  if (!record) return undefined;
  return {
    activation: enumValue(record.activation, "lifecycle.activation", path, ["auto", "manual"] as const) ?? DEFAULT_PLUGIN_LIFECYCLE.activation,
    start: enumValue(record.start, "lifecycle.start", path, ["lazy", "eager"] as const) ?? DEFAULT_PLUGIN_LIFECYCLE.start,
    reload: enumValue(record.reload, "lifecycle.reload", path, ["runtime", "session", "restart"] as const) ?? DEFAULT_PLUGIN_LIFECYCLE.reload,
    state: enumValue(record.state, "lifecycle.state", path, ["ephemeral", "workspace", "user"] as const) ?? DEFAULT_PLUGIN_LIFECYCLE.state,
    events: optionalStringArray(record.events, "lifecycle.events", path) ?? DEFAULT_PLUGIN_LIFECYCLE.events,
  };
}

function contributionValue(
  record: Record<string, unknown>,
  contributes: Record<string, unknown> | undefined,
  field: "hooks" | "mcpServers" | "tools",
  path: string,
): unknown {
  if (record[field] !== undefined && contributes?.[field] !== undefined) {
    throw new Error(`Plugin ${field} cannot be declared in both the manifest root and contributes: ${path}`);
  }
  return contributes?.[field] ?? record[field];
}

export async function loadPluginHooks(plugins: readonly LoadedPlugin[]): Promise<HooksConfig> {
  const merged: HooksConfig = {};
  for (const plugin of plugins) {
    if (!isPluginActive(plugin) || !plugin.hooksPath) continue;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(await assertPluginContributionPath(plugin, plugin.hooksPath), "utf8"));
    } catch (error) {
      throw new Error(`Invalid hooks contribution from plugin ${plugin.name}: ${plugin.hooksPath}`, { cause: error });
    }
    if (!isRecord(value)) throw new Error(`Plugin hooks must be an object: ${plugin.hooksPath}`);
    const hooks = isRecord(value.hooks) ? value.hooks : value;
    for (const event of HOOK_EVENTS) {
      const groups = hooks[event];
      if (groups === undefined) continue;
      if (!Array.isArray(groups)) throw new Error(`Plugin hook event ${event} must be an array: ${plugin.hooksPath}`);
      (merged[event] ??= []).push(...groups as NonNullable<HooksConfig[HookEvent]>);
    }
  }
  return merged;
}

export async function loadPluginMcpConfig(
  plugins: readonly LoadedPlugin[],
  env: Record<string, string | undefined>,
  onServer?: (name: string, plugin: LoadedPlugin) => void,
): Promise<McpConfig> {
  const mcpServers: McpConfig["mcpServers"] = {};
  for (const plugin of plugins) {
    if (!isPluginActive(plugin) || !plugin.mcpPath) continue;
    const contribution = await loadMcpConfig(await assertPluginContributionPath(plugin, plugin.mcpPath), env);
    for (const [name, server] of Object.entries(contribution.mcpServers)) {
      if (mcpServers[name]) throw new Error(`Duplicate plugin MCP server ${name} contributed by ${plugin.name}`);
      mcpServers[name] = server;
      onServer?.(name, plugin);
    }
  }
  return { mcpServers };
}

export function mergePluginHooks(base: HooksConfig | undefined, contribution: HooksConfig): HooksConfig {
  const merged: HooksConfig = {};
  for (const event of HOOK_EVENTS) {
    const groups = [...(base?.[event] ?? []), ...(contribution[event] ?? [])];
    if (groups.length) merged[event] = groups;
  }
  return merged;
}

export function mergePluginMcpConfig(base: McpConfig, contribution: McpConfig): McpConfig {
  const mcpServers = { ...base.mcpServers };
  for (const [name, server] of Object.entries(contribution.mcpServers)) {
    if (mcpServers[name]) throw new Error(`Plugin MCP server conflicts with configured server: ${name}`);
    mcpServers[name] = server;
  }
  return { mcpServers };
}

export async function assertPluginContributionPath(plugin: Pick<LoadedPlugin, "name" | "root">, path: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    throw new Error(`Plugin ${plugin.name} contribution does not exist: ${path}`, { cause: error });
  }
  const fromRoot = relative(plugin.root, canonical);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Plugin ${plugin.name} contribution escapes plugin root through a symbolic link: ${path}`);
  }
  return canonical;
}

function contributionPath(root: string, value: string, field: string): string {
  if (isAbsolute(value)) throw new Error(`Plugin ${field} path must be relative: ${value}`);
  const path = resolve(root, value);
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`Plugin ${field} path escapes plugin root: ${value}`);
  }
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalObject(value: unknown, field: string, path: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Plugin ${field} must be an object: ${path}`);
  return value;
}

function optionalString(value: unknown, field: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Plugin ${field} must be a non-empty string: ${path}`);
  return value.trim();
}

function requiredString(value: unknown, field: string, path: string): string {
  const result = optionalString(value, field, path);
  if (!result) throw new Error(`Plugin ${field} must be a non-empty string: ${path}`);
  return result;
}

function requiredIdentifier(value: unknown, field: string, path: string): string {
  const result = requiredString(value, field, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(result)) {
    throw new Error(`Plugin ${field} has an invalid identifier: ${path}`);
  }
  return result;
}

function optionalBoolean(value: unknown, field: string, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Plugin ${field} must be boolean: ${path}`);
  return value;
}

function optionalPositiveInteger(value: unknown, field: string, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Plugin ${field} must be a positive integer: ${path}`);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Plugin ${field} must be an array of non-empty strings: ${path}`);
  }
  return value.map((item) => (item as string).trim());
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  field: string,
  path: string,
  allowed: T,
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Plugin ${field} must be one of ${allowed.join(", ")}: ${path}`);
  }
  return value as T[number];
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
