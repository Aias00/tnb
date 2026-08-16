import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { withFileLock } from "../../utils/lockfile";

export const MAX_SCHEDULED_JOBS = 50;
export const RECURRING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type ScheduledJob = {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  createdAt: number;
  lastFiredAt?: number;
};

type ScheduledFile = { version: 2; tasks: ScheduledJob[]; deletedTasks: Record<string, number> };
type WakeListener = (prompt: string, source: string) => void;

export class ScheduleManager {
  readonly filePath: string;
  private durable = new Map<string, ScheduledJob>();
  private deletedDurable = new Map<string, number>();
  private session = new Map<string, ScheduledJob>();
  private listeners = new Set<WakeListener>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private wakeup: { id: string; prompt: string; scheduledAt: number; timer: ReturnType<typeof setTimeout> } | undefined;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async initialize(): Promise<void> {
    const state = await readScheduledFile(this.filePath);
    this.adopt(state);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runTick(), 1_000);
    this.timer.unref?.();
    void this.runTick();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clearSession();
    await this.persist();
  }

  clearSession(): void {
    this.session.clear();
    if (this.wakeup) clearTimeout(this.wakeup.timer);
    this.wakeup = undefined;
  }

  subscribe(listener: WakeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(input: { cron: string; prompt: string; recurring?: boolean; durable?: boolean }): Promise<ScheduledJob> {
    if (!parseCronExpression(input.cron)) throw new Error(`Invalid cron expression '${input.cron}'. Expected 5 fields: M H DoM Mon DoW.`);
    if (nextCronRun(input.cron, Date.now()) === null) throw new Error(`Cron expression '${input.cron}' has no match in the next year`);
    if (this.list().length >= MAX_SCHEDULED_JOBS) throw new Error(`Too many scheduled jobs (max ${MAX_SCHEDULED_JOBS})`);
    const task: ScheduledJob = {
      id: randomUUID().slice(0, 8),
      cron: input.cron.trim(),
      prompt: requireText(input.prompt, "prompt"),
      recurring: input.recurring ?? true,
      durable: input.durable ?? false,
      createdAt: Date.now(),
    };
    (task.durable ? this.durable : this.session).set(task.id, task);
    if (task.durable) {
      this.deletedDurable.delete(task.id);
      await this.persist();
    }
    return structuredClone(task);
  }

  list(): ScheduledJob[] {
    return [...this.session.values(), ...this.durable.values()]
      .sort((a, b) => (nextCronRun(a.cron, a.lastFiredAt ?? a.createdAt) ?? Infinity) - (nextCronRun(b.cron, b.lastFiredAt ?? b.createdAt) ?? Infinity))
      .map((task) => structuredClone(task));
  }

  async remove(id: string): Promise<boolean> {
    if (this.session.delete(id)) return true;
    await this.persist();
    if (!this.durable.delete(id)) return false;
    this.deletedDurable.set(id, Date.now());
    await this.persist();
    return true;
  }

  scheduleWakeup(input: { delaySeconds: number; prompt: string }): { id: string; scheduledAt: number } {
    if (!Number.isSafeInteger(input.delaySeconds) || input.delaySeconds < 1 || input.delaySeconds > 86_400) {
      throw new Error("schedule_wakeup delay_seconds must be an integer from 1 to 86400");
    }
    if (this.wakeup) clearTimeout(this.wakeup.timer);
    const id = `wake_${randomUUID().slice(0, 8)}`;
    const prompt = requireText(input.prompt, "prompt");
    const scheduledAt = Date.now() + input.delaySeconds * 1_000;
    const timer = setTimeout(() => {
      this.wakeup = undefined;
      this.emit(prompt, id);
    }, input.delaySeconds * 1_000);
    timer.unref?.();
    this.wakeup = { id, prompt, scheduledAt, timer };
    return { id, scheduledAt };
  }

  currentWakeup(): { id: string; prompt: string; scheduledAt: number } | undefined {
    if (!this.wakeup) return undefined;
    const { timer: _timer, ...snapshot } = this.wakeup;
    return { ...snapshot };
  }

  cancelWakeup(): boolean {
    if (!this.wakeup) return false;
    clearTimeout(this.wakeup.timer);
    this.wakeup = undefined;
    return true;
  }

  enqueue(prompt: string, source: string): void {
    this.emit(requireText(prompt, "prompt"), source);
  }

  private async runTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tick();
    } finally {
      this.ticking = false;
    }
  }

  private async tick(now = Date.now()): Promise<void> {
    const fired: ScheduledJob[] = [];
    let durableChanged = false;
    for (const task of this.list()) {
      if (task.recurring && now - task.createdAt >= RECURRING_MAX_AGE_MS) {
        (task.durable ? this.durable : this.session).delete(task.id);
        if (task.durable) {
          this.deletedDurable.set(task.id, now);
          durableChanged = true;
        }
        continue;
      }
      const next = nextCronRun(task.cron, task.lastFiredAt ?? task.createdAt);
      if (next !== null && next <= now) fired.push(task);
    }
    for (const task of fired) {
      this.emit(task.prompt, `cron:${task.id}`);
      const collection = task.durable ? this.durable : this.session;
      if (task.recurring) {
        const current = collection.get(task.id);
        if (current) current.lastFiredAt = now;
      } else {
        collection.delete(task.id);
        if (task.durable) this.deletedDurable.set(task.id, now);
      }
      if (task.durable) durableChanged = true;
    }
    if (durableChanged) await this.persist();
  }

  private emit(prompt: string, source: string): void {
    for (const listener of this.listeners) listener(prompt, source);
  }

  private async persist(): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const disk = await readScheduledFile(this.filePath);
      const merged = mergeScheduledFiles(disk, {
        version: 2,
        tasks: [...this.durable.values()],
        deletedTasks: Object.fromEntries(this.deletedDurable),
      });
      await writeScheduledFile(this.filePath, merged);
      this.adopt(merged);
    });
  }

  private adopt(state: ScheduledFile): void {
    this.durable = new Map(state.tasks.map((task) => [task.id, structuredClone(task)]));
    this.deletedDurable = new Map(Object.entries(state.deletedTasks));
  }
}

async function readScheduledFile(filePath: string): Promise<ScheduledFile> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return { version: 2, tasks: [], deletedTasks: {} };
    if (error instanceof SyntaxError) throw new Error(`Invalid scheduled tasks JSON: ${filePath}`, { cause: error });
    throw error;
  }
  if (!isObject(value) || !Array.isArray(value.tasks) || (value.version !== 1 && value.version !== 2)) {
    throw new Error(`Invalid scheduled tasks file: ${filePath}`);
  }
  const deletedTasks: Record<string, number> = {};
  if (value.version === 2) {
    if (!isObject(value.deletedTasks)) throw new Error(`Invalid scheduled tasks file: ${filePath}`);
    for (const [id, deletedAt] of Object.entries(value.deletedTasks)) {
      if (typeof deletedAt !== "number" || !Number.isFinite(deletedAt)) throw new Error(`Invalid scheduled tasks file: ${filePath}`);
      deletedTasks[id] = deletedAt;
    }
  }
  const tasks = value.tasks.map(parsePersistedJob).filter((task) => deletedTasks[task.id] === undefined);
  return { version: 2, tasks, deletedTasks };
}

function mergeScheduledFiles(first: ScheduledFile, second: ScheduledFile): ScheduledFile {
  const deletedTasks = { ...first.deletedTasks };
  for (const [id, deletedAt] of Object.entries(second.deletedTasks)) {
    deletedTasks[id] = Math.max(deletedTasks[id] ?? 0, deletedAt);
  }
  const tasks = new Map<string, ScheduledJob>();
  for (const task of [...first.tasks, ...second.tasks]) {
    if (deletedTasks[task.id] !== undefined) continue;
    const current = tasks.get(task.id);
    if (!current) {
      tasks.set(task.id, structuredClone(task));
      continue;
    }
    const lastFiredAt = Math.max(current.lastFiredAt ?? 0, task.lastFiredAt ?? 0);
    tasks.set(task.id, {
      ...(current.createdAt <= task.createdAt ? current : task),
      ...(lastFiredAt > 0 ? { lastFiredAt } : {}),
    });
  }
  return { version: 2, tasks: [...tasks.values()], deletedTasks };
}

async function writeScheduledFile(filePath: string, value: ScheduledFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

type CronField = { values: Set<number>; wildcard: boolean };
type CronFields = [CronField, CronField, CronField, CronField, CronField];
const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;

export function parseCronExpression(expression: string): CronFields | undefined {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const fields = parts.map((part, index) => parseField(part!, FIELD_RANGES[index]![0], FIELD_RANGES[index]![1], index === 4));
  return fields.every(Boolean) ? fields as CronFields : undefined;
}

export function nextCronRun(expression: string, fromMs: number): number | null {
  const fields = parseCronExpression(expression);
  if (!fields) return null;
  const candidate = new Date(fromMs);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const limit = candidate.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (candidate.getTime() <= limit) {
    const dayOfMonthMatches = fields[2].values.has(candidate.getDate());
    const dayOfWeekMatches = fields[4].values.has(candidate.getDay());
    const dayMatches = fields[2].wildcard
      ? dayOfWeekMatches
      : fields[4].wildcard
        ? dayOfMonthMatches
        : dayOfMonthMatches || dayOfWeekMatches;
    if (fields[0].values.has(candidate.getMinutes()) && fields[1].values.has(candidate.getHours()) && dayMatches && fields[3].values.has(candidate.getMonth() + 1)) {
      return candidate.getTime();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

function parseField(value: string, minimum: number, maximum: number, sundayAlias: boolean): CronField | undefined {
  const result = new Set<number>();
  for (const segment of value.split(",")) {
    const [rangePart, stepPart] = segment.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isSafeInteger(step) || step < 1) return undefined;
    let start: number;
    let end: number;
    if (rangePart === "*") [start, end] = [minimum, maximum];
    else if (rangePart?.includes("-")) {
      const values = rangePart.split("-").map(Number);
      if (values.length !== 2) return undefined;
      [start, end] = values as [number, number];
    } else start = end = Number(rangePart);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < minimum || end > maximum || start > end) return undefined;
    for (let current = start; current <= end; current += step) result.add(sundayAlias && current === 7 ? 0 : current);
  }
  return result.size ? { values: result, wildcard: value === "*" || value.startsWith("*/") } : undefined;
}

function parsePersistedJob(value: unknown): ScheduledJob {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.cron !== "string" || typeof value.prompt !== "string" || typeof value.createdAt !== "number" || typeof value.recurring !== "boolean") {
    throw new Error(`Invalid scheduled task in ${JSON.stringify(value)}`);
  }
  if (!parseCronExpression(value.cron)) throw new Error(`Invalid cron expression for scheduled task ${value.id}`);
  return {
    id: value.id,
    cron: value.cron,
    prompt: value.prompt,
    createdAt: value.createdAt,
    recurring: value.recurring,
    durable: true,
    ...(typeof value.lastFiredAt === "number" ? { lastFiredAt: value.lastFiredAt } : {}),
  };
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`schedule ${name} must be non-empty`);
  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
