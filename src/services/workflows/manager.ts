import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { projectSessionDirectory } from "../session/storage";

export type WorkflowParameter = {
  name: string;
  description?: string;
  required: boolean;
  defaultValue?: string;
};

export type WorkflowStep = {
  id: string;
  description: string;
  prompt: string;
  agentType: string;
  dependsOn: string[];
};

export type WorkflowDefinition = {
  version: 1;
  name: string;
  description?: string;
  parameters: WorkflowParameter[];
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
};

export type WorkflowRunStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type WorkflowRunStatus =
  | "running"
  | "paused"
  | "completed"
  | "completed_with_errors";

export type WorkflowRunStep = WorkflowStep & {
  status: WorkflowRunStepStatus;
  attempt: number;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
};

export type WorkflowRun = {
  version: 1;
  id: string;
  workflowName?: string;
  description?: string;
  parameters: Record<string, string>;
  parameterDefinitions: WorkflowParameter[];
  templateSteps: WorkflowStep[];
  steps: WorkflowRunStep[];
  maxConcurrency: number;
  status: WorkflowRunStatus;
  pauseRequested: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
};

export type WorkflowDefinitionSummary = {
  name: string;
  description?: string;
  parameterCount: number;
  stepCount: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowRunSummary = {
  id: string;
  workflowName?: string;
  status: WorkflowRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  stepCount: number;
  completedSteps: number;
  failedSteps: number;
  skippedSteps: number;
};

type WorkflowManagerOptions = {
  configDir?: string;
  cwd?: string;
  now?: () => Date;
  runIdFactory?: () => string;
};

export type StartRunInput = {
  definitionName?: string;
  description?: string;
  parameters?: Record<string, string>;
  parameterDefinitions?: WorkflowParameter[];
  steps: WorkflowStep[];
  maxConcurrency: number;
};

type ExecuteRunInput = {
  signal: AbortSignal;
  pauseAfterStepCount?: number;
  runStep(step: WorkflowRunStep, run: WorkflowRun, signal: AbortSignal): Promise<string>;
};

export class WorkflowManager {
  readonly #definitionsDir: string;
  readonly #runsDir: string;
  readonly #now: () => Date;
  readonly #runIdFactory: () => string;

  constructor(options: WorkflowManagerOptions = {}) {
    const configDir = resolve(options.configDir ?? process.env.TNB_HOME ?? join(homedir(), ".tnb"));
    const cwd = resolve(options.cwd ?? process.cwd());
    const root = join(projectSessionDirectory(configDir, cwd), "workflows");
    this.#definitionsDir = join(root, "definitions");
    this.#runsDir = join(root, "runs");
    this.#now = options.now ?? (() => new Date());
    this.#runIdFactory = options.runIdFactory ?? (() => `workflow-${randomUUID().slice(0, 12)}`);
  }

  async saveDefinition(input: {
    name: string;
    description?: string;
    parameters?: WorkflowParameter[];
    steps: WorkflowStep[];
  }): Promise<WorkflowDefinition> {
    const name = validateWorkflowName(input.name, "workflow name");
    const steps = normalizeWorkflowSteps(input.steps);
    const parameters = normalizeWorkflowParameters(input.parameters ?? []);
    const existing = await this.getDefinition(name).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    const timestamp = this.#timestamp();
    const definition: WorkflowDefinition = {
      version: 1,
      name,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      parameters,
      steps,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.#writeJson(this.#definitionPath(name), definition);
    return structuredClone(definition);
  }

  async getDefinition(name: string): Promise<WorkflowDefinition> {
    return parseWorkflowDefinition(await this.#readJson(this.#definitionPath(validateWorkflowName(name, "workflow name"))));
  }

  async listDefinitions(): Promise<WorkflowDefinitionSummary[]> {
    const names = await this.#listJsonFiles(this.#definitionsDir);
    const definitions = await Promise.all(names.map(async (name) => {
      const definition = await this.getDefinition(name);
      return {
        name: definition.name,
        ...(definition.description ? { description: definition.description } : {}),
        parameterCount: definition.parameters.length,
        stepCount: definition.steps.length,
        createdAt: definition.createdAt,
        updatedAt: definition.updatedAt,
      } satisfies WorkflowDefinitionSummary;
    }));
    definitions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return definitions;
  }

  async deleteDefinition(name: string): Promise<boolean> {
    try {
      await unlink(this.#definitionPath(validateWorkflowName(name, "workflow name")));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async startRun(input: StartRunInput): Promise<WorkflowRun> {
    const steps = normalizeWorkflowSteps(input.steps);
    const parameterDefinitions = normalizeWorkflowParameters(input.parameterDefinitions ?? []);
    const parameters = resolveWorkflowParameters(parameterDefinitions, input.parameters ?? {});
    const materialized = normalizeWorkflowSteps(materializeTemplateSteps(steps, parameters));
    const timestamp = this.#timestamp();
    const run: WorkflowRun = {
      version: 1,
      id: this.#runIdFactory(),
      ...(input.definitionName ? { workflowName: validateWorkflowName(input.definitionName, "workflow name") } : {}),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      parameters,
      parameterDefinitions,
      templateSteps: steps,
      steps: materializeRunSteps(materialized),
      maxConcurrency: positiveInteger(input.maxConcurrency, "workflow max_concurrency"),
      status: "paused",
      pauseRequested: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.#writeRun(run);
    return structuredClone(run);
  }

  async getRun(runId: string): Promise<WorkflowRun> {
    const run = parseWorkflowRun(await this.#readJson(this.#runPath(runId)));
    const recovered = normalizeRecoveredRun(run, this.#timestamp());
    if (recovered.changed) await this.#writeRun(recovered.run);
    return structuredClone(recovered.run);
  }

  async listRuns(): Promise<WorkflowRunSummary[]> {
    const names = await this.#listJsonFiles(this.#runsDir);
    const runs = await Promise.all(names.map(async (name) => summarizeRun(await this.getRun(name))));
    runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return runs;
  }

  async pauseRun(runId: string): Promise<WorkflowRun> {
    const run = await this.getRun(runId);
    if (run.status === "completed" || run.status === "completed_with_errors") {
      throw new Error(`Workflow run ${run.id} is already finished`);
    }
    run.pauseRequested = true;
    if (run.status !== "running") run.status = "paused";
    run.updatedAt = this.#timestamp();
    await this.#writeRun(run);
    return structuredClone(run);
  }

  async resumeRun(runId: string, input: ExecuteRunInput): Promise<WorkflowRun> {
    const run = await this.getRun(runId);
    if (run.status === "completed" || run.status === "completed_with_errors") {
      throw new Error(`Workflow run ${run.id} is already finished; rerun it instead`);
    }
    return this.#executeRun(run, input);
  }

  async rerun(runId: string, input: ExecuteRunInput & {
    maxConcurrency?: number;
    useLatestDefinition?: boolean;
  }): Promise<WorkflowRun> {
    const prior = await this.getRun(runId);
    const definition = input.useLatestDefinition && prior.workflowName
      ? await this.getDefinition(prior.workflowName)
      : undefined;
    const next = await this.startRun({
      ...(prior.workflowName ? { definitionName: prior.workflowName } : {}),
      ...((definition?.description ?? prior.description) ? { description: definition?.description ?? prior.description } : {}),
      parameterDefinitions: definition?.parameters ?? prior.parameterDefinitions,
      steps: definition?.steps ?? prior.templateSteps,
      parameters: prior.parameters,
      maxConcurrency: input.maxConcurrency ?? prior.maxConcurrency,
    });
    return this.#executeRun(next, input);
  }

  async #executeRun(run: WorkflowRun, input: ExecuteRunInput): Promise<WorkflowRun> {
    let current = structuredClone(run);
    current.pauseRequested = false;
    current.status = "running";
    current.startedAt ??= this.#timestamp();
    current.updatedAt = this.#timestamp();
    delete current.completedAt;
    delete current.lastError;
    await this.#writeRun(current);

    let executedThisInvocation = 0;
    try {
      while (true) {
        current = await this.getRun(current.id);
        if (input.signal.aborted) throw new DOMException("Workflow aborted", "AbortError");
        if (current.pauseRequested) {
          current.status = "paused";
          current.updatedAt = this.#timestamp();
          await this.#writeRun(current);
          return structuredClone(current);
        }

        const terminal = new Set(
          current.steps
            .filter((step) => step.status === "completed" || step.status === "failed" || step.status === "skipped")
            .map((step) => step.id),
        );
        const ready = current.steps.filter((step) =>
          step.status === "pending" && step.dependsOn.every((dependency) => terminal.has(dependency))
        );

        if (!ready.length) {
          if (current.steps.every((step) => step.status !== "pending" && step.status !== "running")) break;
          throw new Error("workflow dependency graph could not make progress");
        }

        let stateChanged = false;
        for (const step of ready) {
          if (step.dependsOn.some((dependency) => current.steps.find((candidate) => candidate.id === dependency)?.status !== "completed")) {
            step.status = "skipped";
            step.error = "A dependency did not complete successfully";
            step.completedAt = this.#timestamp();
            stateChanged = true;
          }
        }
        if (stateChanged) {
          current.updatedAt = this.#timestamp();
          await this.#writeRun(current);
          continue;
        }

        const runnable = ready.filter((step) => step.status === "pending");
        if (!runnable.length) continue;

        let remainingBudget = input.pauseAfterStepCount === undefined
          ? undefined
          : Math.max(0, input.pauseAfterStepCount - executedThisInvocation);
        if (remainingBudget !== undefined && remainingBudget === 0) {
          current.status = "paused";
          current.updatedAt = this.#timestamp();
          await this.#writeRun(current);
          return structuredClone(current);
        }

        const batchSize = remainingBudget === undefined
          ? current.maxConcurrency
          : Math.max(1, Math.min(current.maxConcurrency, remainingBudget));
        const batch = runnable.slice(0, batchSize);
        const startedAt = this.#timestamp();
        for (const step of batch) {
          step.status = "running";
          step.attempt += 1;
          step.startedAt = startedAt;
          delete step.output;
          delete step.error;
          delete step.completedAt;
        }
        current.updatedAt = this.#timestamp();
        await this.#writeRun(current);

        const settled = await Promise.allSettled(batch.map((step) => input.runStep(structuredClone(step), current, input.signal)));
        for (let index = 0; index < batch.length; index += 1) {
          const step = batch[index]!;
          const result = settled[index]!;
          step.completedAt = this.#timestamp();
          if (result.status === "fulfilled") {
            step.status = "completed";
            step.output = result.value;
            delete step.error;
          } else {
            step.status = "failed";
            step.error = result.reason instanceof Error ? result.reason.message : String(result.reason);
            delete step.output;
          }
          executedThisInvocation += 1;
        }
        const persisted = await this.getRun(current.id);
        if (persisted.pauseRequested) current.pauseRequested = true;
        current.updatedAt = this.#timestamp();
        await this.#writeRun(current);

        remainingBudget = input.pauseAfterStepCount === undefined
          ? undefined
          : Math.max(0, input.pauseAfterStepCount - executedThisInvocation);
        if (remainingBudget !== undefined && remainingBudget === 0 && current.steps.some((step) => step.status === "pending")) {
          current.status = "paused";
          current.updatedAt = this.#timestamp();
          await this.#writeRun(current);
          return structuredClone(current);
        }
      }
    } catch (error) {
      current.status = "paused";
      current.lastError = error instanceof Error ? error.message : String(error);
      current.updatedAt = this.#timestamp();
      await this.#writeRun(current);
      if (input.signal.aborted) throw error;
      throw error;
    }

    current.status = current.steps.every((step) => step.status === "completed")
      ? "completed"
      : "completed_with_errors";
    current.pauseRequested = false;
    current.completedAt = this.#timestamp();
    current.updatedAt = current.completedAt;
    await this.#writeRun(current);
    return structuredClone(current);
  }

  async #listJsonFiles(directory: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
  }

  async #readJson(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, "utf8"));
  }

  async #writeRun(run: WorkflowRun): Promise<void> {
    await this.#writeJson(this.#runPath(run.id), run);
  }

  async #writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }

  #definitionPath(name: string): string {
    return join(this.#definitionsDir, `${name}.json`);
  }

  #runPath(runId: string): string {
    return join(this.#runsDir, `${validateRunId(runId)}.json`);
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

export function normalizeWorkflowParameters(parameters: WorkflowParameter[]): WorkflowParameter[] {
  const normalized = parameters.map((parameter, index) => normalizeWorkflowParameter(parameter, index));
  const names = new Set<string>();
  for (const parameter of normalized) {
    if (names.has(parameter.name)) throw new Error(`workflow parameters contain a duplicate name: ${parameter.name}`);
    names.add(parameter.name);
  }
  return normalized;
}

export function normalizeWorkflowSteps(steps: WorkflowStep[]): WorkflowStep[] {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("workflow steps must be a non-empty array");
  const normalized = steps.map((step, index) => normalizeWorkflowStep(step, index));
  const ids = new Set<string>();
  for (const step of normalized) {
    if (ids.has(step.id)) throw new Error(`workflow step id is duplicated: ${step.id}`);
    ids.add(step.id);
  }
  for (const step of normalized) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`workflow step ${step.id} depends on unknown step: ${dependency}`);
      if (dependency === step.id) throw new Error(`workflow step ${step.id} cannot depend on itself`);
    }
  }
  assertWorkflowGraph(normalized);
  return normalized;
}

export function resolveWorkflowParameters(
  definitions: WorkflowParameter[],
  values: Record<string, string>,
): Record<string, string> {
  const normalizedValues = normalizeParameterValues(values);
  if (!definitions.length) return normalizedValues;
  const resolved: Record<string, string> = {};
  for (const definition of definitions) {
    const provided = normalizedValues[definition.name];
    if (provided !== undefined) {
      resolved[definition.name] = provided;
      continue;
    }
    if (definition.defaultValue !== undefined) {
      resolved[definition.name] = definition.defaultValue;
      continue;
    }
    if (definition.required) {
      throw new Error(`workflow parameter ${definition.name} is required`);
    }
  }
  for (const [name, value] of Object.entries(normalizedValues)) {
    if (!(name in resolved)) resolved[name] = value;
  }
  return resolved;
}

function materializeTemplateSteps(steps: WorkflowStep[], parameters: Record<string, string>): WorkflowStep[] {
  return steps.map((step) => ({
    id: interpolateTemplate(step.id, parameters, `workflow step ${step.id}.id`),
    description: interpolateTemplate(step.description, parameters, `workflow step ${step.id}.description`),
    prompt: interpolateTemplate(step.prompt, parameters, `workflow step ${step.id}.prompt`),
    agentType: interpolateTemplate(step.agentType, parameters, `workflow step ${step.id}.agent_type`),
    dependsOn: step.dependsOn.map((dependency) => interpolateTemplate(dependency, parameters, `workflow step ${step.id}.depends_on`)),
  }));
}

function materializeRunSteps(steps: WorkflowStep[]): WorkflowRunStep[] {
  return steps.map((step) => ({
    ...step,
    status: "pending",
    attempt: 0,
  }));
}

function normalizeRecoveredRun(run: WorkflowRun, timestamp: string): { run: WorkflowRun; changed: boolean } {
  let changed = false;
  if (run.status === "running") {
    run.status = "paused";
    run.lastError = "Workflow process ended before the run was restored";
    changed = true;
  }
  for (const step of run.steps) {
    if (step.status !== "running") continue;
    step.status = "pending";
    step.error = "Workflow process ended before the step completed";
    delete step.output;
    delete step.completedAt;
    changed = true;
  }
  if (changed) run.updatedAt = timestamp;
  return { run, changed };
}

function summarizeRun(run: WorkflowRun): WorkflowRunSummary {
  return {
    id: run.id,
    ...(run.workflowName ? { workflowName: run.workflowName } : {}),
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    stepCount: run.steps.length,
    completedSteps: run.steps.filter((step) => step.status === "completed").length,
    failedSteps: run.steps.filter((step) => step.status === "failed").length,
    skippedSteps: run.steps.filter((step) => step.status === "skipped").length,
  };
}

function normalizeWorkflowParameter(value: WorkflowParameter, index: number): WorkflowParameter {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`workflow parameters[${index}] must be an object`);
  }
  const name = validateIdentifier((value as { name?: unknown }).name, `workflow parameters[${index}].name`);
  const description = typeof value.description === "string" && value.description.trim()
    ? value.description.trim()
    : undefined;
  const required = value.required === undefined ? value.defaultValue === undefined : Boolean(value.required);
  const defaultValue = value.defaultValue === undefined
    ? undefined
    : normalizeScalarString(value.defaultValue, `workflow parameters[${index}].default`);
  return {
    name,
    ...(description ? { description } : {}),
    required,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  };
}

function normalizeWorkflowStep(value: WorkflowStep, index: number): WorkflowStep {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`workflow steps[${index}] must be an object`);
  }
  const candidate = value as Partial<WorkflowStep> & Record<string, unknown>;
  return {
    id: requiredString(candidate.id, `workflow steps[${index}].id`),
    description: requiredString(candidate.description, `workflow steps[${index}].description`),
    prompt: requiredString(candidate.prompt, `workflow steps[${index}].prompt`),
    agentType: candidate.agentType === undefined
      ? "general-purpose"
      : requiredString(candidate.agentType, `workflow steps[${index}].agent_type`),
    dependsOn: candidate.dependsOn === undefined
      ? []
      : stringArray(candidate.dependsOn, `workflow steps[${index}].depends_on`),
  };
}

function assertWorkflowGraph(steps: WorkflowStep[]): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`workflow contains a dependency cycle at step: ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id);
}

function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workflow definition");
  const definition = value as Partial<WorkflowDefinition> & Record<string, unknown>;
  if (definition.version !== 1) throw new Error("Invalid workflow definition");
  return {
    version: 1,
    name: validateWorkflowName(definition.name, "workflow name"),
    ...(typeof definition.description === "string" && definition.description.trim()
      ? { description: definition.description.trim() }
      : {}),
    parameters: normalizeWorkflowParameters(arrayValue(definition.parameters, "workflow parameters") as WorkflowParameter[]),
    steps: normalizeWorkflowSteps(arrayValue(definition.steps, "workflow steps") as WorkflowStep[]),
    createdAt: requiredString(definition.createdAt, "workflow createdAt"),
    updatedAt: requiredString(definition.updatedAt, "workflow updatedAt"),
  };
}

function parseWorkflowRun(value: unknown): WorkflowRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workflow run");
  const run = value as Partial<WorkflowRun> & Record<string, unknown>;
  if (run.version !== 1) throw new Error("Invalid workflow run");
  const status = requiredString(run.status, "workflow run status");
  if (!["running", "paused", "completed", "completed_with_errors"].includes(status)) {
    throw new Error("Invalid workflow run");
  }
  const steps = arrayValue(run.steps, "workflow run steps").map((step, index) => parseWorkflowRunStep(step, index));
  const templateSteps = normalizeWorkflowSteps(arrayValue(run.templateSteps, "workflow templateSteps") as WorkflowStep[]);
  const parameterDefinitions = normalizeWorkflowParameters(
    arrayValue(run.parameterDefinitions, "workflow parameterDefinitions") as WorkflowParameter[],
  );
  const parameters = normalizeParameterValues(objectRecord(run.parameters, "workflow parameters"));
  return {
    version: 1,
    id: validateRunId(run.id),
    ...(run.workflowName === undefined ? {} : { workflowName: validateWorkflowName(run.workflowName, "workflow name") }),
    ...(typeof run.description === "string" && run.description.trim() ? { description: run.description.trim() } : {}),
    parameters,
    parameterDefinitions,
    templateSteps,
    steps,
    maxConcurrency: positiveInteger(run.maxConcurrency, "workflow max_concurrency"),
    status: status as WorkflowRunStatus,
    pauseRequested: Boolean(run.pauseRequested),
    createdAt: requiredString(run.createdAt, "workflow createdAt"),
    updatedAt: requiredString(run.updatedAt, "workflow updatedAt"),
    ...(run.startedAt === undefined ? {} : { startedAt: requiredString(run.startedAt, "workflow startedAt") }),
    ...(run.completedAt === undefined ? {} : { completedAt: requiredString(run.completedAt, "workflow completedAt") }),
    ...(typeof run.lastError === "string" && run.lastError.trim() ? { lastError: run.lastError.trim() } : {}),
  };
}

function parseWorkflowRunStep(value: unknown, index: number): WorkflowRunStep {
  const step = normalizeWorkflowStep(objectRecord(value, `workflow steps[${index}]`) as WorkflowStep, index);
  const record = value as Partial<WorkflowRunStep> & Record<string, unknown>;
  const status = requiredString(record.status, `workflow steps[${index}].status`);
  if (!["pending", "running", "completed", "failed", "skipped"].includes(status)) {
    throw new Error(`workflow steps[${index}].status must be a valid status`);
  }
  return {
    ...step,
    status: status as WorkflowRunStepStatus,
    attempt: nonNegativeInteger(record.attempt, `workflow steps[${index}].attempt`),
    ...(typeof record.output === "string" ? { output: record.output } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(record.startedAt === undefined ? {} : { startedAt: requiredString(record.startedAt, `workflow steps[${index}].startedAt`) }),
    ...(record.completedAt === undefined ? {} : { completedAt: requiredString(record.completedAt, `workflow steps[${index}].completedAt`) }),
  };
}

function interpolateTemplate(value: string, parameters: Record<string, string>, label: string): string {
  return value.replaceAll(/{{\s*([a-zA-Z0-9_-]+)\s*}}/g, (_match, name: string) => {
    const replacement = parameters[name];
    if (replacement === undefined) throw new Error(`${label} references missing workflow parameter: ${name}`);
    return replacement;
  });
}

function normalizeParameterValues(value: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    output[validateIdentifier(name, "workflow parameter name")] = normalizeScalarString(item, `workflow parameter ${name}`);
  }
  return output;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value.map((item) => String(item).trim());
}

function validateWorkflowName(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.trim())) {
    throw new Error(`${label} must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/`);
  }
  return value.trim();
}

function validateIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/.test(value.trim())) {
    throw new Error(`${label} must match /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/`);
  }
  return value.trim();
}

function validateRunId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.trim())) {
    throw new Error("workflow run id is invalid");
  }
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}

function normalizeScalarString(value: unknown, label: string): string {
  if (typeof value === "string") {
    if (!value.trim()) throw new Error(`${label} must be a non-empty scalar`);
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new Error(`${label} must be a string, number, or boolean`);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
