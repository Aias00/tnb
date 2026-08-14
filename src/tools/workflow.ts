import { cpus } from "node:os";

import { defineTool, type AgentTool } from "../core/tool";
import {
  WorkflowManager,
  type WorkflowParameter,
  type WorkflowRun,
  type WorkflowStep,
  type StartRunInput,
  normalizeWorkflowParameters,
  normalizeWorkflowSteps,
} from "../services/workflows/manager";

type WorkflowAction =
  | "run"
  | "save_definition"
  | "list_definitions"
  | "get_definition"
  | "delete_definition"
  | "list_runs"
  | "get_run"
  | "pause_run"
  | "resume_run"
  | "rerun_run";

type WorkflowInput =
  | {
      action: "run";
      legacyMode: boolean;
      manager: WorkflowManager;
      definitionName?: string;
      description?: string;
      parameters?: Record<string, string>;
      parameterDefinitions?: WorkflowParameter[];
      steps?: WorkflowStep[];
      maxConcurrency: number;
      pauseAfterStepCount?: number;
    }
  | {
      action: "save_definition";
      manager: WorkflowManager;
      name: string;
      description?: string;
      parameters: WorkflowParameter[];
      steps: WorkflowStep[];
    }
  | {
      action: "list_definitions" | "list_runs";
      manager: WorkflowManager;
    }
  | {
      action: "get_definition" | "delete_definition";
      manager: WorkflowManager;
      name: string;
    }
  | {
      action: "get_run" | "pause_run" | "resume_run";
      manager: WorkflowManager;
      runId: string;
      pauseAfterStepCount?: number;
    }
  | {
      action: "rerun_run";
      manager: WorkflowManager;
      runId: string;
      maxConcurrency?: number;
      pauseAfterStepCount?: number;
      useLatestDefinition: boolean;
    };

export function createWorkflowTool(agentTool: AgentTool): AgentTool {
  return defineTool({
    name: "workflow",
    description: [
      "Run an explicit multi-agent workflow as a dependency graph.",
      "Use only when the user asks for workflow or multi-agent orchestration, or when a selected skill/command explicitly requires it.",
      "Supports saved workflow definitions, parameterized runs, persisted run state, and pause/resume/rerun controls.",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [
            "run",
            "save_definition",
            "list_definitions",
            "get_definition",
            "delete_definition",
            "list_runs",
            "get_run",
            "pause_run",
            "resume_run",
            "rerun_run",
          ],
        },
        name: { type: "string", description: "Saved workflow definition name." },
        run_id: { type: "string", description: "Persisted workflow run identifier." },
        description: { type: "string", description: "Workflow definition or run description." },
        params: {
          type: "object",
          additionalProperties: {
            anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
          },
          description: "Runtime workflow parameters used for {{name}} interpolation.",
        },
        parameters: {
          type: "array",
          description: "Workflow parameter definitions for save_definition.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              required: { type: "boolean" },
              default: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
            },
          },
        },
        steps: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "description", "prompt"],
            properties: {
              id: { type: "string", description: "Unique stable step identifier." },
              description: { type: "string", description: "Short progress label." },
              prompt: { type: "string", description: "Complete standalone task briefing." },
              agent_type: { type: "string", description: "Agent profile; defaults to general-purpose." },
              depends_on: { type: "array", items: { type: "string" }, description: "Step IDs that must finish first." },
            },
          },
        },
        max_concurrency: {
          type: "integer",
          minimum: 1,
          description: "Maximum simultaneous Agent steps. Defaults to a CPU-aware value capped at 16.",
        },
        pause_after_step_count: {
          type: "integer",
          minimum: 1,
          description: "Pause the run after this many steps are attempted in the current invocation.",
        },
        use_latest_definition: {
          type: "boolean",
          description: "For rerun_run, reload the latest saved named definition before creating the new run.",
        },
      },
    },
    validate(input) {
      const value = objectInput(input, "workflow input");
      const manager = new WorkflowManager();
      const action = parseAction(value.action, value.steps);
      if (action === "save_definition") {
        return {
          action,
          manager,
          name: requiredString(value.name, "workflow name"),
          ...(stringOrUndefined(value.description)?.trim() ? { description: stringOrUndefined(value.description)!.trim() } : {}),
          parameters: parseParameterDefinitions(value.parameters),
          steps: parseSteps(value.steps),
        } satisfies WorkflowInput;
      }
      if (action === "list_definitions" || action === "list_runs") {
        return { action, manager } satisfies WorkflowInput;
      }
      if (action === "get_definition" || action === "delete_definition") {
        return {
          action,
          manager,
          name: requiredString(value.name, "workflow name"),
        } satisfies WorkflowInput;
      }
      if (action === "get_run" || action === "pause_run" || action === "resume_run") {
        return {
          action,
          manager,
          runId: requiredString(value.run_id, "workflow run_id"),
          ...(value.pause_after_step_count === undefined
            ? {}
            : { pauseAfterStepCount: positiveInteger(value.pause_after_step_count, "workflow pause_after_step_count") }),
        } satisfies WorkflowInput;
      }
      if (action === "rerun_run") {
        return {
          action,
          manager,
          runId: requiredString(value.run_id, "workflow run_id"),
          ...(value.max_concurrency === undefined
            ? {}
            : { maxConcurrency: positiveInteger(value.max_concurrency, "workflow max_concurrency") }),
          ...(value.pause_after_step_count === undefined
            ? {}
            : { pauseAfterStepCount: positiveInteger(value.pause_after_step_count, "workflow pause_after_step_count") }),
          useLatestDefinition: value.use_latest_definition === true,
        } satisfies WorkflowInput;
      }
      return {
        action,
        legacyMode: isLegacyRunInput(value),
        manager,
        ...(value.name === undefined ? {} : { definitionName: requiredString(value.name, "workflow name") }),
        ...(stringOrUndefined(value.description)?.trim() ? { description: stringOrUndefined(value.description)!.trim() } : {}),
        ...(value.params === undefined ? {} : { parameters: parseParameterValues(value.params) }),
        ...(value.parameters === undefined ? {} : { parameterDefinitions: parseParameterDefinitions(value.parameters) }),
        ...(value.steps === undefined ? {} : { steps: parseSteps(value.steps) }),
        maxConcurrency: value.max_concurrency === undefined
          ? defaultWorkflowConcurrency()
          : positiveInteger(value.max_concurrency, "workflow max_concurrency"),
        ...(value.pause_after_step_count === undefined
          ? {}
          : { pauseAfterStepCount: positiveInteger(value.pause_after_step_count, "workflow pause_after_step_count") }),
      } satisfies WorkflowInput;
    },
    async execute(input, signal) {
      switch (input.action) {
        case "save_definition": {
          const definition = await input.manager.saveDefinition({
            name: input.name,
            ...(input.description ? { description: input.description } : {}),
            parameters: input.parameters,
            steps: input.steps,
          });
          return JSON.stringify({
            status: "saved",
            definition: serializeDefinition(definition),
          });
        }
        case "list_definitions": {
          return JSON.stringify({
            definitions: await input.manager.listDefinitions(),
          });
        }
        case "get_definition": {
          return JSON.stringify({
            definition: serializeDefinition(await input.manager.getDefinition(input.name)),
          });
        }
        case "delete_definition": {
          const deleted = await input.manager.deleteDefinition(input.name);
          return JSON.stringify({
            status: deleted ? "deleted" : "not_found",
            name: input.name,
          });
        }
        case "list_runs": {
          return JSON.stringify({
            runs: await input.manager.listRuns(),
          });
        }
        case "get_run": {
          return JSON.stringify({
            run: serializeRun(await input.manager.getRun(input.runId)),
          });
        }
        case "pause_run": {
          return JSON.stringify({
            run: serializeRun(await input.manager.pauseRun(input.runId)),
          });
        }
        case "resume_run": {
          const run = await input.manager.resumeRun(input.runId, {
            signal,
            ...(input.pauseAfterStepCount === undefined ? {} : { pauseAfterStepCount: input.pauseAfterStepCount }),
            runStep: (step, run, runSignal) => executeStep(agentTool, step, currentDependencyOutputs(step, run), runSignal),
          });
          return JSON.stringify({
            run: serializeRun(run),
          });
        }
        case "rerun_run": {
          const run = await input.manager.rerun(input.runId, {
            signal,
            ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
            ...(input.pauseAfterStepCount === undefined ? {} : { pauseAfterStepCount: input.pauseAfterStepCount }),
            useLatestDefinition: input.useLatestDefinition,
            runStep: (step, run, runSignal) => executeStep(agentTool, step, currentDependencyOutputs(step, run), runSignal),
          });
          return JSON.stringify({
            run: serializeRun(run),
          });
        }
        case "run": {
          const run = await startWorkflowRun(input, signal, agentTool);
          if (input.legacyMode) return JSON.stringify(serializeLegacyRun(run));
          return JSON.stringify({
            run: serializeRun(run),
          });
        }
      }
    },
    access: "execute",
    isReadOnly: (input) => input.action !== "run" && input.action !== "save_definition" && input.action !== "delete_definition" &&
      input.action !== "pause_run" && input.action !== "resume_run" && input.action !== "rerun_run",
    isConcurrencySafe: () => false,
  });
}

export function defaultWorkflowConcurrency(cpuCount = cpus().length): number {
  return Math.min(16, Math.max(2, cpuCount - 2));
}

async function startWorkflowRun(input: Extract<WorkflowInput, { action: "run" }>, signal: AbortSignal, agentTool: AgentTool): Promise<WorkflowRun> {
  const definition = input.definitionName ? await input.manager.getDefinition(input.definitionName) : undefined;
  const startInput: StartRunInput = {
    parameterDefinitions: input.parameterDefinitions ?? definition?.parameters ?? [],
    steps: input.steps ?? definition?.steps ?? missingSteps(),
    maxConcurrency: input.maxConcurrency,
  };
  if (input.definitionName) startInput.definitionName = input.definitionName;
  const description = input.description ?? definition?.description;
  if (description) startInput.description = description;
  if (input.parameters) startInput.parameters = input.parameters;
  const run = await input.manager.startRun(startInput);
  return input.manager.resumeRun(run.id, {
    signal,
    ...(input.pauseAfterStepCount === undefined ? {} : { pauseAfterStepCount: input.pauseAfterStepCount }),
    runStep: (step, current, runSignal) => executeStep(agentTool, step, currentDependencyOutputs(step, current), runSignal),
  });
}

async function executeStep(
  agentTool: AgentTool,
  step: WorkflowStep,
  dependencyOutputs: string,
  signal: AbortSignal,
): Promise<string> {
  const prompt = dependencyOutputs
    ? `${step.prompt}\n\nCompleted dependency outputs:\n${dependencyOutputs}`
    : step.prompt;
  const validated = agentTool.validate({
    description: step.description,
    prompt,
    subagent_type: step.agentType,
    run_in_background: false,
  });
  const output = await agentTool.execute(validated, signal);
  if (typeof output !== "string") throw new Error("Workflow Agent returned non-text output");
  return output;
}

function currentDependencyOutputs(step: WorkflowStep, run: WorkflowRun): string {
  return step.dependsOn.map((id) => {
    const result = run.steps.find((candidate) => candidate.id === id);
    if (!result) throw new Error(`workflow step ${step.id} depends on unknown step: ${id}`);
    return `<workflow_dependency id="${escapeAttribute(id)}">\n${result.output ?? ""}\n</workflow_dependency>`;
  }).join("\n\n");
}

function serializeDefinition(definition: Awaited<ReturnType<WorkflowManager["getDefinition"]>>) {
  return {
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    parameters: definition.parameters.map((parameter) => ({
      name: parameter.name,
      ...(parameter.description ? { description: parameter.description } : {}),
      required: parameter.required,
      ...(parameter.defaultValue === undefined ? {} : { default: parameter.defaultValue }),
    })),
    steps: definition.steps.map(serializeStepDefinition),
    created_at: definition.createdAt,
    updated_at: definition.updatedAt,
  };
}

function serializeRun(run: WorkflowRun) {
  return {
    run_id: run.id,
    ...(run.workflowName ? { workflow_name: run.workflowName } : {}),
    ...(run.description ? { description: run.description } : {}),
    status: run.status,
    parameters: run.parameters,
    max_concurrency: run.maxConcurrency,
    pause_requested: run.pauseRequested,
    steps: run.steps.map((step) => ({
      id: step.id,
      description: step.description,
      agent_type: step.agentType,
      depends_on: step.dependsOn,
      status: step.status,
      attempt: step.attempt,
      ...(step.output === undefined ? {} : { output: step.output }),
      ...(step.error === undefined ? {} : { error: step.error }),
      ...(step.startedAt === undefined ? {} : { started_at: step.startedAt }),
      ...(step.completedAt === undefined ? {} : { completed_at: step.completedAt }),
    })),
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    ...(run.startedAt === undefined ? {} : { started_at: run.startedAt }),
    ...(run.completedAt === undefined ? {} : { completed_at: run.completedAt }),
    ...(run.lastError === undefined ? {} : { last_error: run.lastError }),
  };
}

function serializeLegacyRun(run: WorkflowRun) {
  return {
    status: run.status,
    steps: run.steps.map((step) => ({
      id: step.id,
      status: step.status === "running" || step.status === "pending" ? "skipped" : step.status,
      ...(step.output === undefined ? {} : { output: step.output }),
      ...(step.error === undefined ? {} : { error: step.error }),
    })),
  };
}

function serializeStepDefinition(step: WorkflowStep) {
  return {
    id: step.id,
    description: step.description,
    prompt: step.prompt,
    agent_type: step.agentType,
    ...(step.dependsOn.length ? { depends_on: step.dependsOn } : {}),
  };
}

function missingSteps(): never {
  throw new Error("workflow run requires either steps or a saved workflow name");
}

function parseAction(action: unknown, steps: unknown): WorkflowAction {
  if (action === undefined) return steps === undefined ? "list_definitions" : "run";
  if (typeof action !== "string") throw new Error("workflow action must be a string");
  const normalized = action.trim() as WorkflowAction;
  if (![
    "run",
    "save_definition",
    "list_definitions",
    "get_definition",
    "delete_definition",
    "list_runs",
    "get_run",
    "pause_run",
    "resume_run",
    "rerun_run",
  ].includes(normalized)) {
    throw new Error(`Unsupported workflow action: ${action}`);
  }
  return normalized;
}

function isLegacyRunInput(value: Record<string, unknown>): boolean {
  const allowed = new Set(["steps", "max_concurrency"]);
  return !("action" in value) && Object.keys(value).every((key) => allowed.has(key));
}

function parseSteps(value: unknown): WorkflowStep[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("workflow steps must be a non-empty array");
  return normalizeWorkflowSteps(value.map((raw, index) => parseStep(raw, index)));
}

function parseStep(value: unknown, index: number): WorkflowStep {
  const step = objectInput(value, `workflow steps[${index}]`);
  return {
    id: requiredString(step.id, `workflow steps[${index}].id`),
    description: requiredString(step.description, `workflow steps[${index}].description`),
    prompt: requiredString(step.prompt, `workflow steps[${index}].prompt`),
    agentType: step.agent_type === undefined
      ? "general-purpose"
      : requiredString(step.agent_type, `workflow steps[${index}].agent_type`),
    dependsOn: step.depends_on === undefined
      ? []
      : stringArray(step.depends_on, `workflow steps[${index}].depends_on`),
  };
}

function parseParameterDefinitions(value: unknown): WorkflowParameter[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("workflow parameters must be an array");
  return normalizeWorkflowParameters(value.map((raw, index) => parseParameterDefinition(raw, index)));
}

function parseParameterDefinition(value: unknown, index: number): WorkflowParameter {
  const parameter = objectInput(value, `workflow parameters[${index}]`);
  return {
    name: requiredString(parameter.name, `workflow parameters[${index}].name`),
    ...(stringOrUndefined(parameter.description)?.trim()
      ? { description: stringOrUndefined(parameter.description)!.trim() }
      : {}),
    required: parameter.required === undefined ? parameter.default === undefined : Boolean(parameter.required),
    ...(parameter.default === undefined
      ? {}
      : { defaultValue: scalarString(parameter.default, `workflow parameters[${index}].default`) }),
  };
}

function parseParameterValues(value: unknown): Record<string, string> {
  const parameters = objectInput(value, "workflow params");
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(parameters)) {
    output[requiredString(key, `workflow param ${key}`)] = scalarString(raw, `workflow param ${key}`);
  }
  return output;
}

function objectInput(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object`);
  return input as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value.map((item) => String(item).trim());
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function scalarString(value: unknown, label: string): string {
  if (typeof value === "string") {
    if (!value.trim()) throw new Error(`${label} must be a non-empty scalar`);
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error(`${label} must be a string, number, or boolean`);
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
