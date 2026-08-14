import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ProviderCatalog } from "./config";

export type ProviderSmokeCaseId = "glm" | "qwen" | "deepseek" | "openrouter";
export type ProviderSmokeProbe = "text" | "tool-use";

export type ProviderSmokeCase = {
  id: ProviderSmokeCaseId;
  name: string;
  credentialEnv: string[];
  apiKeyEnv: string[];
  baseUrlEnv?: string[];
  modelEnv?: string[];
  reasoningEnv?: string[];
  defaultBaseUrl: string;
  defaultModel: string;
  compatProfile: ProviderSmokeCaseId;
};

export type ProviderSmokeResolvedCase = {
  id: ProviderSmokeCaseId;
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoning: boolean;
  compatProfile: ProviderSmokeCaseId;
};

export type ProviderSmokeTarget = {
  id: string;
  name: string;
  model: string;
};

export type ProviderSmokeIdentity = Pick<ProviderSmokeTarget, "id" | "name">;

export type ProviderSmokeDiagnostic = {
  ok: true;
  provider: string;
  api: string;
  endpoint: string;
  model: string;
  probe: ProviderSmokeProbe;
  stopReason: string;
  eventCount: number;
  text?: string;
  toolCall?: {
    name: string;
    input: unknown;
  };
  usage?: Record<string, unknown>;
};

export type ProviderSmokeProbeResult = {
  probe: ProviderSmokeProbe;
  diagnostic: ProviderSmokeDiagnostic;
};

export type ProviderSmokeSuccess = {
  status: "passed";
  provider: ProviderSmokeTarget;
  probes: ProviderSmokeProbeResult[];
};

export type ProviderSmokeSkip = {
  status: "skipped";
  provider: ProviderSmokeIdentity;
  missingEnv: string[];
};

export type ProviderSmokeFailure = {
  status: "failed";
  provider: ProviderSmokeIdentity;
  error: string;
};

export type ProviderSmokeResult = ProviderSmokeSuccess | ProviderSmokeSkip | ProviderSmokeFailure;

export type ProviderSmokeSummary = {
  results: ProviderSmokeResult[];
  passed: number;
  skipped: number;
  failed: number;
};

export type ProviderSmokeCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ProviderSmokeCommandRunner = (
  args: string[],
  env: Record<string, string | undefined>,
) => Promise<ProviderSmokeCommandResult>;

export const KNOWN_PROVIDER_SMOKE_CASES: readonly ProviderSmokeCase[] = [
  {
    id: "glm",
    name: "GLM",
    credentialEnv: ["ZAI_API_KEY", "GLM_API_KEY"],
    apiKeyEnv: ["ZAI_API_KEY", "GLM_API_KEY"],
    baseUrlEnv: ["GLM_BASE_URL", "ZAI_BASE_URL"],
    modelEnv: ["GLM_MODEL"],
    reasoningEnv: ["GLM_REASONING"],
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5.2",
    compatProfile: "glm",
  },
  {
    id: "qwen",
    name: "Qwen",
    credentialEnv: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
    apiKeyEnv: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
    baseUrlEnv: ["QWEN_BASE_URL", "DASHSCOPE_BASE_URL"],
    modelEnv: ["QWEN_MODEL"],
    reasoningEnv: ["QWEN_REASONING"],
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    compatProfile: "qwen",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    credentialEnv: ["DEEPSEEK_API_KEY"],
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
    baseUrlEnv: ["DEEPSEEK_BASE_URL"],
    modelEnv: ["DEEPSEEK_MODEL"],
    reasoningEnv: ["DEEPSEEK_REASONING"],
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-pro",
    compatProfile: "deepseek",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    credentialEnv: ["OPENROUTER_API_KEY"],
    apiKeyEnv: ["OPENROUTER_API_KEY"],
    baseUrlEnv: ["OPENROUTER_BASE_URL"],
    modelEnv: ["OPENROUTER_MODEL"],
    reasoningEnv: ["OPENROUTER_REASONING"],
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    compatProfile: "openrouter",
  },
] as const;

export function selectProviderSmokeCases(ids?: Iterable<string>): ProviderSmokeCase[] {
  if (!ids) return [...KNOWN_PROVIDER_SMOKE_CASES];
  const requested = new Set([...ids].map((value) => value.trim().toLowerCase()).filter(Boolean));
  return KNOWN_PROVIDER_SMOKE_CASES.filter((provider) => requested.has(provider.id));
}

export function resolveProviderSmokeCase(
  provider: ProviderSmokeCase,
  env: Record<string, string | undefined>,
): ProviderSmokeResolvedCase | ProviderSmokeSkip {
  const apiKey = firstDefined(provider.apiKeyEnv, env);
  if (!apiKey) {
    return {
      status: "skipped",
      provider: { id: provider.id, name: provider.name },
      missingEnv: provider.credentialEnv,
    };
  }
  return {
    id: provider.id,
    name: provider.name,
    apiKey,
    baseUrl: firstDefined(provider.baseUrlEnv ?? [], env) ?? provider.defaultBaseUrl,
    model: firstDefined(provider.modelEnv ?? [], env) ?? provider.defaultModel,
    reasoning: parseBooleanEnv(firstDefined(provider.reasoningEnv ?? [], env), provider.compatProfile !== "openrouter"),
    compatProfile: provider.compatProfile,
  };
}

export function buildSmokeCatalog(provider: ProviderSmokeResolvedCase): ProviderCatalog {
  return {
    providers: {
      [provider.id]: {
        id: provider.id,
        name: provider.name,
        api: "openai-completions",
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        headers: {},
        compat: { profile: provider.compatProfile },
        models: [{
          id: provider.model,
          name: provider.model,
          contextWindow: 128_000,
          maxTokens: 16_384,
          reasoning: provider.reasoning,
          supportsVision: false,
          supportsPdf: false,
          compat: { profile: provider.compatProfile },
          samplingParams: {},
        }],
      },
    },
  };
}

export async function runProviderSmokeMatrix(options: {
  providers?: Iterable<string>;
  env: Record<string, string | undefined>;
  cwd: string;
  runCommand: ProviderSmokeCommandRunner;
}): Promise<ProviderSmokeSummary> {
  const results: ProviderSmokeResult[] = [];
  for (const candidate of selectProviderSmokeCases(options.providers)) {
    const resolved = resolveProviderSmokeCase(candidate, options.env);
    if ("status" in resolved) {
      results.push(resolved);
      continue;
    }
    try {
      const probes = await runProviderSmokeCase({
        provider: resolved,
        cwd: options.cwd,
        env: options.env,
        runCommand: options.runCommand,
      });
      results.push({ status: "passed", provider: smokeTarget(resolved), probes });
    } catch (error) {
      results.push({
        status: "failed",
        provider: { id: candidate.id, name: candidate.name },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    passed: results.filter((result) => result.status === "passed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
}

export async function runConfiguredProviderSmokeMatrix(options: {
  providers: Iterable<string>;
  catalog: ProviderCatalog;
  env: Record<string, string | undefined>;
  runCommand: ProviderSmokeCommandRunner;
}): Promise<ProviderSmokeSummary> {
  const results: ProviderSmokeResult[] = [];
  for (const id of [...options.providers].map((value) => value.trim()).filter(Boolean)) {
    const provider = options.catalog.providers[id];
    if (!provider) {
      results.push({ status: "failed", provider: { id, name: id }, error: `Unknown configured provider: ${id}` });
      continue;
    }
    const model = provider.models[0];
    if (!model) {
      results.push({ status: "failed", provider: { id, name: provider.name }, error: `Provider ${id} has no models` });
      continue;
    }
    const target = { id, name: provider.name, model: model.id };
    try {
      const probes = await runExistingProviderSmokeCase({
        provider: target,
        env: options.env,
        runCommand: options.runCommand,
      });
      results.push({ status: "passed", provider: target, probes });
    } catch (error) {
      results.push({
        status: "failed",
        provider: { id, name: provider.name },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summarizeProviderSmokeResults(results);
}

export function mergeProviderSmokeSummaries(...summaries: ProviderSmokeSummary[]): ProviderSmokeSummary {
  return summarizeProviderSmokeResults(summaries.flatMap((summary) => summary.results));
}

async function runProviderSmokeCase(options: {
  provider: ProviderSmokeResolvedCase;
  cwd: string;
  env: Record<string, string | undefined>;
  runCommand: ProviderSmokeCommandRunner;
}): Promise<ProviderSmokeProbeResult[]> {
  const configDir = await mkdtemp(join(tmpdir(), `tnb-provider-smoke-${options.provider.id}-`));
  try {
    await writeFile(
      join(configDir, "models.json"),
      JSON.stringify(buildSmokeCatalog(options.provider), null, 2),
    );
    const commandEnv = {
      ...options.env,
      TNB_HOME: configDir,
    };
    const text = await runProviderProbe({
      provider: options.provider,
      probe: "text",
      runCommand: options.runCommand,
      env: commandEnv,
    });
    const toolUse = await runProviderProbe({
      provider: options.provider,
      probe: "tool-use",
      runCommand: options.runCommand,
      env: commandEnv,
    });
    return [text, toolUse];
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

async function runExistingProviderSmokeCase(options: {
  provider: ProviderSmokeTarget;
  env: Record<string, string | undefined>;
  runCommand: ProviderSmokeCommandRunner;
}): Promise<ProviderSmokeProbeResult[]> {
  const text = await runProviderProbe({
    provider: options.provider,
    probe: "text",
    runCommand: options.runCommand,
    env: options.env,
  });
  const toolUse = await runProviderProbe({
    provider: options.provider,
    probe: "tool-use",
    runCommand: options.runCommand,
    env: options.env,
  });
  return [text, toolUse];
}

async function runProviderProbe(options: {
  provider: ProviderSmokeTarget;
  probe: ProviderSmokeProbe;
  env: Record<string, string | undefined>;
  runCommand: ProviderSmokeCommandRunner;
}): Promise<ProviderSmokeProbeResult> {
  const args = [
    "run",
    "src/entrypoints/cli.ts",
    "provider",
    "test",
    options.provider.id,
    "--model",
    options.provider.model,
    "--json",
  ];
  if (options.probe === "tool-use") args.push("--tools");
  const result = await options.runCommand(args, options.env);
  if (result.exitCode !== 0) {
    throw new Error([
      `${options.provider.id} ${options.probe} probe failed with exit code ${result.exitCode}`,
      result.stderr.trim(),
      result.stdout.trim(),
    ].filter(Boolean).join("\n"));
  }
  const diagnostic = parseDiagnosticJson(result.stdout);
  assertDiagnostic(diagnostic, options.provider, options.probe);
  return { probe: options.probe, diagnostic };
}

function parseDiagnosticJson(stdout: string): ProviderSmokeDiagnostic {
  try {
    return JSON.parse(stdout) as ProviderSmokeDiagnostic;
  } catch (error) {
    throw new Error(`Provider diagnostic returned invalid JSON`, { cause: error });
  }
}

function assertDiagnostic(
  diagnostic: ProviderSmokeDiagnostic,
  provider: ProviderSmokeTarget,
  probe: ProviderSmokeProbe,
): void {
  if (!diagnostic.ok) throw new Error(`${provider.id} ${probe} probe did not report ok=true`);
  if (diagnostic.provider !== provider.id) {
    throw new Error(`${provider.id} ${probe} probe returned provider ${diagnostic.provider}`);
  }
  if (diagnostic.model !== provider.model) {
    throw new Error(`${provider.id} ${probe} probe returned model ${diagnostic.model}`);
  }
  if (diagnostic.probe !== probe) {
    throw new Error(`${provider.id} ${probe} probe returned probe ${diagnostic.probe}`);
  }
  if (!diagnostic.stopReason) {
    throw new Error(`${provider.id} ${probe} probe omitted stopReason`);
  }
  if (!(diagnostic.eventCount > 0)) {
    throw new Error(`${provider.id} ${probe} probe reported no stream events`);
  }
  const inputTokens = diagnostic.usage?.inputTokens;
  const outputTokens = diagnostic.usage?.outputTokens;
  if (typeof inputTokens !== "number" || inputTokens <= 0) {
    throw new Error(`${provider.id} ${probe} probe reported invalid input token usage`);
  }
  if (typeof outputTokens !== "number" || outputTokens <= 0) {
    throw new Error(`${provider.id} ${probe} probe reported invalid output token usage`);
  }
  if (probe === "text") {
    if (!diagnostic.text?.trim()) {
      throw new Error(`${provider.id} text probe returned no text payload`);
    }
    return;
  }
  if (diagnostic.toolCall?.name !== "provider_diagnostic") {
    throw new Error(`${provider.id} tool probe returned ${diagnostic.toolCall?.name ?? "no tool call"}`);
  }
  const toolInput = diagnostic.toolCall.input as { value?: unknown } | undefined;
  if (!toolInput || toolInput.value !== "ok") {
    throw new Error(`${provider.id} tool probe returned unexpected diagnostic arguments`);
  }
  if (diagnostic.stopReason !== "tool-use") {
    throw new Error(`${provider.id} tool probe returned stop reason ${diagnostic.stopReason}`);
  }
}

function smokeTarget(provider: ProviderSmokeResolvedCase): ProviderSmokeTarget {
  return { id: provider.id, name: provider.name, model: provider.model };
}

function summarizeProviderSmokeResults(results: ProviderSmokeResult[]): ProviderSmokeSummary {
  return {
    passed: results.filter((result) => result.status === "passed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
}

function firstDefined(names: readonly string[], env: Record<string, string | undefined>): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

export function renderProviderSmokeSummary(summary: ProviderSmokeSummary): string {
  const lines: string[] = [];
  for (const result of summary.results) {
    if (result.status === "skipped") {
      lines.push(`[skip] ${result.provider.id}: missing ${result.missingEnv.join(" or ")}`);
      continue;
    }
    if (result.status === "failed") {
      lines.push(`[fail] ${result.provider.id}: ${result.error}`);
      continue;
    }
    for (const probe of result.probes) {
      lines.push(
        `[pass] ${result.provider.id} ${probe.probe}: ${probe.diagnostic.model} ` +
        `events=${probe.diagnostic.eventCount} stop=${probe.diagnostic.stopReason}`,
      );
    }
  }
  lines.push(`summary: passed=${summary.passed} skipped=${summary.skipped} failed=${summary.failed}`);
  return `${lines.join("\n")}\n`;
}

export function workspaceRoot(from = import.meta.dir): string {
  return resolve(from, "..", "..");
}
