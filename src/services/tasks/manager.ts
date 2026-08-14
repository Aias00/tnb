import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export type TaskRecord = {
  id: string;
  type: "work-item" | "agent";
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
  profile?: string;
  output?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

type PersistedTaskState = {
  version: 1;
  nextWorkItemId: number;
  tasks: TaskRecord[];
};

export type TaskUpdate = {
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: "pending" | "in_progress" | "completed" | "deleted";
  owner?: string;
  addBlocks?: string[];
  addBlockedBy?: string[];
  metadata?: Record<string, unknown>;
};

export type TaskLifecycleHooks = {
  beforeCreate?(task: TaskRecord): Promise<void>;
  beforeComplete?(task: TaskRecord): Promise<void>;
};

export class TaskManager {
  private filePath: string;
  private nextWorkItemId = 1;
  private tasks = new Map<string, TaskRecord>();
  private controllers = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private snapshot: readonly TaskRecord[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private generation = 0;
  private lifecycleHooks: TaskLifecycleHooks = {};

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly current = (): readonly TaskRecord[] => this.snapshot;

  setLifecycleHooks(hooks: TaskLifecycleHooks): void {
    this.lifecycleHooks = hooks;
  }

  async initialize(): Promise<void> {
    await this.load(this.filePath);
  }

  async switchStorage(filePath: string): Promise<void> {
    this.stopAll("Task was stopped because the active session changed", false);
    await this.commit();
    this.generation += 1;
    this.filePath = filePath;
    await this.load(filePath);
  }

  async shutdown(): Promise<void> {
    this.stopAll("Task was stopped because tnb exited", true);
    await this.commit();
  }

  recoverableAgents(): TaskRecord[] {
    return [...this.tasks.values()]
      .filter((task) => task.type === "agent" && task.status === "stopped" && task.metadata?.recoveryPending === true)
      .map((task) => structuredClone(task));
  }

  restartableAgent(taskId: string): TaskRecord | undefined {
    const task = this.tasks.get(taskId);
    return task?.type === "agent" ? structuredClone(task) : undefined;
  }

  async restartAgent(
    taskId: string,
    run: (signal: AbortSignal) => Promise<string>,
  ): Promise<TaskRecord> {
    const task = this.tasks.get(taskId);
    if (!task || task.type !== "agent") throw new Error(`Agent task not found: ${taskId}`);
    if (task.status === "running") return structuredClone(task);
    if (!['completed', 'stopped', 'failed'].includes(task.status)) {
      throw new Error(`Agent task ${taskId} cannot restart from status ${task.status}`);
    }
    const controller = new AbortController();
    const generation = this.generation;
    task.status = "running";
    task.updatedAt = new Date().toISOString();
    task.metadata = { ...task.metadata, recoveryPending: false, restartedAt: task.updatedAt };
    delete task.error;
    delete task.output;
    this.controllers.set(task.id, controller);
    await this.commit();
    void run(controller.signal).then(
      (output) => this.finishRuntimeTask(task.id, generation, "completed", { output }),
      (error: unknown) => this.finishRuntimeTask(task.id, generation, controller.signal.aborted ? "stopped" : "failed", {
        error: controller.signal.aborted ? "Task was stopped" : error instanceof Error ? error.message : String(error),
      }),
    );
    return structuredClone(task);
  }

  async recoverAgent(taskId: string, run: (signal: AbortSignal) => Promise<string>): Promise<TaskRecord> {
    const task = this.tasks.get(taskId);
    if (!task || task.type !== "agent") throw new Error(`Recoverable agent task not found: ${taskId}`);
    if (task.status !== "stopped" || task.metadata?.recoveryPending !== true) {
      throw new Error(`Agent task ${taskId} is not pending recovery`);
    }
    const controller = new AbortController();
    const generation = this.generation;
    task.status = "running";
    task.updatedAt = new Date().toISOString();
    task.metadata = { ...task.metadata, recoveryPending: false, recoveredAt: task.updatedAt };
    delete task.error;
    delete task.output;
    this.controllers.set(task.id, controller);
    await this.commit();
    void run(controller.signal).then(
      (output) => this.finishRuntimeTask(task.id, generation, "completed", { output }),
      (error: unknown) => this.finishRuntimeTask(task.id, generation, controller.signal.aborted ? "stopped" : "failed", {
        error: controller.signal.aborted ? "Task was stopped" : error instanceof Error ? error.message : String(error),
      }),
    );
    return structuredClone(task);
  }

  async createWorkItem(input: {
    subject: string;
    description: string;
    activeForm?: string;
    metadata?: Record<string, unknown>;
  }): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: String(this.nextWorkItemId),
      type: "work-item",
      subject: input.subject,
      description: input.description,
      status: "pending",
      blocks: [],
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
      ...(input.activeForm ? { activeForm: input.activeForm } : {}),
      ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}),
    };
    await this.lifecycleHooks.beforeCreate?.(structuredClone(task));
    this.nextWorkItemId += 1;
    this.tasks.set(task.id, task);
    await this.commit();
    return structuredClone(task);
  }

  get(taskId: string): TaskRecord | undefined {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : undefined;
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].map((task) => structuredClone(task));
  }

  async update(taskId: string, update: TaskUpdate): Promise<TaskRecord | undefined> {
    const current = this.tasks.get(taskId);
    if (!current) return undefined;
    if (current.type !== "work-item") {
      throw new Error(`Task ${taskId} is a runtime task and cannot be edited with task_update`);
    }
    if (update.status === "deleted") {
      this.tasks.delete(taskId);
      for (const task of this.tasks.values()) {
        task.blocks = task.blocks.filter((id) => id !== taskId);
        task.blockedBy = task.blockedBy.filter((id) => id !== taskId);
      }
      await this.commit();
      return undefined;
    }
    const next = structuredClone(current);
    if (update.subject !== undefined) next.subject = update.subject;
    if (update.description !== undefined) next.description = update.description;
    if (update.activeForm !== undefined) next.activeForm = update.activeForm;
    if (update.owner !== undefined) next.owner = update.owner;
    if (update.status !== undefined) next.status = update.status;
    if (update.metadata !== undefined) {
      const metadata = { ...next.metadata };
      for (const [key, value] of Object.entries(update.metadata)) {
        if (value === null) delete metadata[key];
        else metadata[key] = value;
      }
      next.metadata = metadata;
    }
    for (const blockedId of update.addBlocks ?? []) {
      this.linkDependency(taskId, blockedId);
    }
    for (const blockerId of update.addBlockedBy ?? []) {
      this.linkDependency(blockerId, taskId);
    }
    next.blocks = this.tasks.get(taskId)?.blocks ?? next.blocks;
    next.blockedBy = this.tasks.get(taskId)?.blockedBy ?? next.blockedBy;
    next.updatedAt = new Date().toISOString();
    if (current.status !== "completed" && next.status === "completed") {
      await this.lifecycleHooks.beforeComplete?.(structuredClone(next));
    }
    this.tasks.set(taskId, next);
    await this.commit();
    return structuredClone(next);
  }

  async startAgent(input: {
    subject: string;
    description: string;
    profile: string;
    owner?: string;
    metadata?: Record<string, unknown>;
    run(signal: AbortSignal): Promise<string>;
  }): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: `agent-${randomUUID().slice(0, 8)}`,
      type: "agent",
      subject: input.subject,
      description: input.description,
      profile: input.profile,
      status: "running",
      blocks: [],
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
      ...(input.owner ? { owner: input.owner } : {}),
      ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}),
    };
    const controller = new AbortController();
    const generation = this.generation;
    await this.lifecycleHooks.beforeCreate?.(structuredClone(task));
    this.tasks.set(task.id, task);
    this.controllers.set(task.id, controller);
    await this.commit();
    void input.run(controller.signal).then(
      (output) => this.finishRuntimeTask(task.id, generation, "completed", { output }),
      (error: unknown) => {
        const stopped = controller.signal.aborted;
        return this.finishRuntimeTask(task.id, generation, stopped ? "stopped" : "failed", {
          error: stopped
            ? "Task was stopped"
            : error instanceof Error
              ? error.message
              : String(error),
        });
      },
    );
    return structuredClone(task);
  }

  async stop(taskId: string): Promise<TaskRecord> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`No task found with ID: ${taskId}`);
    if (task.status !== "running") {
      throw new Error(`Task ${taskId} is not running (status: ${task.status})`);
    }
    const controller = this.controllers.get(taskId);
    if (!controller) throw new Error(`Task ${taskId} cannot be stopped by this process`);
    controller.abort();
    task.status = "stopped";
    task.error = "Task was stopped";
    task.updatedAt = new Date().toISOString();
    this.controllers.delete(taskId);
    await this.commit();
    return structuredClone(task);
  }

  private async load(filePath: string): Promise<void> {
    let state: PersistedTaskState;
    try {
      state = parseState(JSON.parse(await readFile(filePath, "utf8")), filePath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      state = { version: 1, nextWorkItemId: 1, tasks: [] };
    }
    this.nextWorkItemId = state.nextWorkItemId;
    this.tasks = new Map(state.tasks.map((task) => [task.id, task]));
    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue;
      task.status = "stopped";
      task.error = "Task process ended before the session was restored";
      if (task.type === "agent") task.metadata = { ...task.metadata, recoveryPending: true };
      task.updatedAt = new Date().toISOString();
      changed = true;
    }
    this.publish();
    if (changed) await this.commit();
  }

  private linkDependency(blockerId: string, blockedId: string): void {
    if (blockerId === blockedId) throw new Error("A task cannot block itself");
    const blocker = this.tasks.get(blockerId);
    const blocked = this.tasks.get(blockedId);
    if (!blocker || !blocked) {
      throw new Error(`Cannot link missing tasks: ${blockerId} -> ${blockedId}`);
    }
    if (!blocker.blocks.includes(blockedId)) blocker.blocks.push(blockedId);
    if (!blocked.blockedBy.includes(blockerId)) blocked.blockedBy.push(blockerId);
    blocker.updatedAt = new Date().toISOString();
    blocked.updatedAt = blocker.updatedAt;
  }

  private async finishRuntimeTask(
    taskId: string,
    generation: number,
    status: "completed" | "failed" | "stopped",
    result: { output?: string; error?: string },
  ): Promise<void> {
    if (generation !== this.generation) return;
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "running") return;
    if (status === "completed") {
      try {
        await this.lifecycleHooks.beforeComplete?.(structuredClone({
          ...task,
          status,
          ...(result.output !== undefined ? { output: result.output } : {}),
        }));
      } catch (error) {
        status = "failed";
        result = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    task.status = status;
    task.updatedAt = new Date().toISOString();
    if (result.output !== undefined) task.output = result.output;
    if (result.error !== undefined) task.error = result.error;
    this.controllers.delete(taskId);
    await this.commit();
  }

  private async commit(): Promise<void> {
    const filePath = this.filePath;
    const state: PersistedTaskState = {
      version: 1,
      nextWorkItemId: this.nextWorkItemId,
      tasks: [...this.tasks.values()].map((task) => structuredClone(task)),
    };
    this.publish();
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(temporary, filePath);
    });
    await this.writeQueue;
  }

  private publish(): void {
    this.snapshot = [...this.tasks.values()].map((task) => structuredClone(task));
    for (const listener of this.listeners) listener();
  }

  private stopAll(reason: string, recoverable: boolean): void {
    const now = new Date().toISOString();
    for (const [taskId, controller] of this.controllers) {
      controller.abort();
      const task = this.tasks.get(taskId);
      if (task?.status === "running") {
        task.status = "stopped";
        task.error = reason;
        if (task.type === "agent") task.metadata = { ...task.metadata, recoveryPending: recoverable };
        task.updatedAt = now;
      }
    }
    this.controllers.clear();
  }
}

function parseState(value: unknown, path: string): PersistedTaskState {
  if (!value || typeof value !== "object") throw new Error(`Invalid task state: ${path}`);
  const state = value as Partial<PersistedTaskState>;
  if (state.version !== 1 || !Number.isSafeInteger(state.nextWorkItemId) || !Array.isArray(state.tasks)) {
    throw new Error(`Invalid task state: ${path}`);
  }
  for (const task of state.tasks) validateTask(task, path);
  return structuredClone(state as PersistedTaskState);
}

function validateTask(value: unknown, path: string): asserts value is TaskRecord {
  if (!value || typeof value !== "object") throw new Error(`Invalid task record: ${path}`);
  const task = value as Partial<TaskRecord>;
  if (
    typeof task.id !== "string" ||
    (task.type !== "work-item" && task.type !== "agent") ||
    typeof task.subject !== "string" ||
    typeof task.description !== "string" ||
    !Array.isArray(task.blocks) ||
    !Array.isArray(task.blockedBy) ||
    typeof task.createdAt !== "string" ||
    typeof task.updatedAt !== "string" ||
    !["pending", "in_progress", "running", "completed", "failed", "stopped"].includes(task.status ?? "")
  ) {
    throw new Error(`Invalid task record: ${path}`);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}
