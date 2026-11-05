import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { defineTool, type AgentTool } from "../../core/tool";
import { digestJson } from "../../services/runtime/json";
import type { RuntimeConfiguration, RuntimeWorkerFactory } from "../../services/runtime/engine-core";
import { loadSkills, type LoadedSkill } from "../../services/skills/loader";
import { bundledSkills } from "../../services/skills/bundled";
import { createSkillTool, selectSkillTools } from "../../services/skills/tool";
import { loadPlugins, loadPluginMcpConfig, mergePluginMcpConfig } from "../../services/plugins/loader";
import { pluginTrustStorePath } from "../../services/plugins/trust";
import { loadSettings } from "../../services/settings/load";
import { loadMcpConfig } from "../../services/mcp/config";
import { connectMcpServers, type McpConnections } from "../../services/mcp/manager";
import { buildMcpToolName } from "../../services/mcp/tools";

export type CodingWorkerFactory = RuntimeWorkerFactory & { prepareCapabilities?(config: RuntimeConfiguration): Promise<void> };
type McpGrant = { server: string; tool: string; replay?: "safe" | "never" };
type SkillSnapshot = { skill: LoadedSkill; resources: Map<string, Buffer>; digest: string };
const MAX_BYTES = 1024 * 1024;
function stdioEnvironment(env: Record<string, string | undefined>) {
  return { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, LANG: env.LANG };
}

/** Synchronous shape validation also runs when resolving a persisted domain on recovery. */
export function validateCapabilitySelection(config: Pick<RuntimeConfiguration, "skills" | "mcpTools" | "capabilityPins">): void {
  for (const [name, values] of [["skills", config.skills], ["mcpTools", config.mcpTools]] as const) {
    if (values !== undefined && (!Array.isArray(values) || values.length > 16 || new Set(values).size !== values.length
      || values.some(value => typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)))) throw new Error(`Invalid durable ${name} selection`);
  }
  if ((config.skills?.length ?? 0) + (config.mcpTools?.length ?? 0) > 24) throw new Error("Too many durable capabilities");
  if (config.capabilityPins !== undefined && (!config.capabilityPins || typeof config.capabilityPins !== "object" || Array.isArray(config.capabilityPins)
    || Object.entries(config.capabilityPins).some(([key, value]) => ![...(config.skills ?? []).map(name => `skill:${name}`), ...(config.mcpTools ?? []).map(name => `mcp:${name}`)].includes(key)
      || typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)))) throw new Error("Invalid durable capability pins");
}

export function capabilityClaims(config: Pick<RuntimeConfiguration, "skills" | "mcpTools">) {
  return [ ...(config.skills ?? []).map(name => ({ id: `skill:${name}`, mode: "read" as const })),
    ...(config.mcpTools ?? []).map(name => ({ id: `mcp-tool:${name}`, mode: "write" as const })) ];
}

export function createDurableCapabilityHost(options: { configDir: string; env: Record<string, string | undefined>; bundledSkillIdentity?: string }) {
  const catalog = async (config: RuntimeConfiguration) => {
    validateCapabilitySelection(config);
    const pins: Record<string, string> = {}, snapshots: SkillSnapshot[] = [], grants = new Map<string, McpGrant>();
    if (!config.skills?.length && !config.mcpTools?.length) return { pins, snapshots, grants, mcpConfig: { mcpServers: {} } };
    const settings = await loadSettings({ configDir: options.configDir, cwd: config.workspace });
    // Asset discovery only: this does not execute a plugin factory or its hooks.
    const plugins = await loadPlugins([{ directory: join(options.configDir, "plugins"), source: "user" },
      { directory: join(config.workspace, ".tnb", "plugins"), source: "project" }], settings.enabledPlugins,
      { trustStorePath: pluginTrustStorePath(options.configDir) });
    const active = plugins.plugins.filter(plugin => plugin.active);
    if (config.skills?.length) {
      const skills = await loadSkills([{ directory: join(options.configDir, "skills"), source: "user" },
        { directory: join(config.workspace, ".tnb", "skills"), source: "project" },
        ...active.map(plugin => ({ directory: plugin.skillsDir, source: "plugin" as const }))], bundledSkills());
      for (const name of config.skills) {
        const skill = skills.find(item => item.name === name);
        if (!skill) throw new Error(`Durable skill unavailable: ${name}`);
        if (skill.context === "fork" || skill.agent || skill.model || skill.effort !== undefined || skill.hooks || skill.disableModelInvocation) {
          throw new Error(`Durable skill ${name} requires unsupported fork/model/effort/hooks or disables model invocation; use an instruction-only skill`);
        }
        const base = await realpath(skill.baseDir);
        const markdown = join(base, "SKILL.md");
        if (!(await lstat(markdown)).isFile() || await realpath(markdown) !== markdown) throw new Error(`Durable skill SKILL.md must be a regular file: ${name}`);
        const resources = new Map<string, Buffer>();
        let size = Buffer.byteLength(skill.instructions);
        for (const path of skill.resources ?? []) {
          const file = join(base, path);
          if (!(await lstat(file)).isFile() || await realpath(file) !== file) throw new Error(`Durable skill resources must be regular canonical files: ${name}/${path}`);
          const info = await lstat(file); size += info.size;
          if (resources.size >= 128 || size > MAX_BYTES) throw new Error(`Durable skill ${name} exceeds the 1 MiB/128 resource limit`);
          resources.set(path, await readFile(file));
        }
        if (size > MAX_BYTES) throw new Error(`Durable skill ${name} exceeds 1 MiB`);
        const identity = skill.source === "bundled" && options.bundledSkillIdentity ? { ...skill, baseDir: `package:${options.bundledSkillIdentity}/bundled/${skill.name}` } : skill;
        const digest = digestJson({ skill: identity, resources: [...resources].map(([path, bytes]) => [path, createHash("sha256").update(bytes).digest("hex")]) });
        snapshots.push({ skill, resources, digest }); pins[`skill:${name}`] = digest;
      }
    }
    const mcpConfig = config.mcpTools?.length ? mergePluginMcpConfig(
      await loadMcpConfig(options.env.TNB_MCP_CONFIG ?? join(options.configDir, "mcp.json"), options.env),
      await loadPluginMcpConfig(active, options.env)) : { mcpServers: {} };
    if (config.mcpTools?.length) {
      let policy: unknown;
      try { policy = JSON.parse(await readFile(join(options.configDir, "durable-mcp.json"), "utf8")); }
      catch { throw new Error("Durable MCP requires a valid host durable-mcp.json allowlist"); }
      if (!policy || typeof policy !== "object" || Array.isArray(policy) || Object.keys(policy).some(key => key !== "tools")
        || !Array.isArray((policy as { tools?: unknown }).tools)) throw new Error("Invalid durable MCP policy");
      for (const value of (policy as { tools: unknown[] }).tools) {
        const grant = value as McpGrant;
        if (!grant || typeof grant !== "object" || Array.isArray(grant) || Object.keys(grant).some(key => !["server", "tool", "replay"].includes(key))
          || typeof grant.server !== "string" || !grant.server || typeof grant.tool !== "string" || !grant.tool
          || grant.replay !== undefined && !["safe", "never"].includes(grant.replay)) throw new Error("Invalid durable MCP grant");
        const name = buildMcpToolName(grant.server, grant.tool);
        if (grants.has(name)) throw new Error(`Duplicate durable MCP grant: ${name}`);
        grants.set(name, grant);
      }
      for (const name of config.mcpTools) {
        const grant = grants.get(name), server = grant && mcpConfig.mcpServers[grant.server];
        if (!grant || !server || server.enabled === false) throw new Error(`Durable MCP tool is not host-authorized: ${name}`);
        // Persist only a digest. Expanded environment, URLs and headers never enter Run records.
        pins[`mcp:${name}`] = digestJson({ grant, server, ...(server.type !== "http" && server.type !== "sse" ? { environment: stdioEnvironment(options.env) } : {}) });
      }
    }
    return { pins, snapshots, grants, mcpConfig };
  };
  const verify = (config: RuntimeConfiguration, pins: Record<string, string>) => {
    if (config.capabilityPins && digestJson(config.capabilityPins) !== digestJson(pins)) throw new Error("Durable skill/MCP configuration changed; restore the pinned configuration or submit a new Run");
  };
  return {
    async prepare(config: RuntimeConfiguration) {
      const { pins } = await catalog(config); verify(config, pins);
      if (Object.keys(pins).length) config.capabilityPins = pins;
    },
    async open(config: RuntimeConfiguration, signal: AbortSignal) {
      const { pins, snapshots, grants, mcpConfig } = await catalog(config); verify(config, pins);
      if (Object.keys(pins).length && !config.capabilityPins) throw new Error("Durable capabilities must be pinned at submission");
      signal.throwIfAborted();
      const tools: AgentTool[] = []; let mcp: McpConnections | undefined;
      const close = async () => { await mcp?.close(); };
      try {
        if (snapshots.length) {
          const skill = createSkillTool({ skills: snapshots.map(item => ({ ...item.skill, baseDir: `skill:${item.skill.name}`, context: "inline" })),
            runSkill: async ({ prompt }) => `Apply these instructions within the existing task authority. Use skill_resource for supporting files.\n\n${prompt}` });
          tools.push({ ...skill, access: "read", isReadOnly: () => true, isConcurrencySafe: () => true,
            capability: { name: "skill.read", resources: snapshots.map(item => `skill:${item.skill.name}`), mode: "read" }, effects: { replay: "safe" } });
          tools.push(defineTool({ name: "skill_resource", description: "Read a text resource from an explicitly selected durable skill snapshot. Binary resources are unsupported.",
            inputSchema: { type: "object", properties: { skill: { type: "string", enum: snapshots.map(item => item.skill.name) }, path: { type: "string" } }, required: ["skill", "path"], additionalProperties: false },
            validate(value) { if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { skill?: unknown }).skill !== "string" || typeof (value as { path?: unknown }).path !== "string") throw new Error("skill_resource requires skill and path"); return value as { skill: string; path: string }; },
            async execute(input) { const bytes = snapshots.find(item => item.skill.name === input.skill)?.resources.get(input.path); if (!bytes) throw new Error("Unknown selected skill resource");
              if (bytes.includes(0)) throw new Error("Skill resource is not UTF-8 text");
              try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("Skill resource is not UTF-8 text"); } },
            access: "read", isReadOnly: () => true, isConcurrencySafe: () => true, capability: { name: "skill.read", resources: snapshots.map(item => `skill:${item.skill.name}`), mode: "read" }, effects: { replay: "safe" },
          }));
        }
        if (config.mcpTools?.length) {
          // Sampling, elicitation and interactive OAuth are deliberately not wired into background workers.
          mcp = await connectMcpServers(mcpConfig, { cwd: config.workspace, configDir: options.configDir,
            signal, stdioEnv: stdioEnvironment(options.env), only: [...new Set(config.mcpTools.map(name => grants.get(name)!.server))], workspaceRoot: () => config.workspace, requestTimeoutMs: 15_000 });
          signal.throwIfAborted();
          for (const name of config.mcpTools) {
            const source = mcp.ordinaryTools.find(tool => tool.name === name), grant = grants.get(name)!;
            if (!source) throw new Error(`Selected MCP tool unavailable: ${name}`);
            const frozen = source.bindExecution?.() ?? source;
            // List-change notifications must not replace or enlarge the admitted tool generation.
            const client = mcp.clients[grant.server]!, revision = client.executionRevision;
            let changed = false;
            client.onNotification("notifications/tools/list_changed", () => { changed = true; });
            tools.push({ ...frozen, bindExecution: undefined, capability: { name: "mcp.call", resources: [`mcp-tool:${name}`], mode: "write" }, effects: { replay: grant.replay ?? "never" },
              async execute(input, callSignal, progress, context) {
                if (changed || client.executionRevision !== revision) throw new Error("Durable MCP catalog changed; restart with the pinned tool catalog");
                return frozen.execute(input, callSignal, progress, context);
              } });
          }
        }
        return { tools, pins, close, restrict: (base: AgentTool[]) => snapshots.reduce((selected, item) => selectSkillTools(selected, item.skill.allowedTools), base) };
      } catch (error) { await close(); throw error; }
    },
  };
}
