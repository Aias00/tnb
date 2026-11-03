import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { digestJson, encodeJson, integer, text } from "./json";
import { migrateRuntime } from "./schema";
import { assertTaskTransition, type DurableAttempt, type DurableRun, type DurableTask, type RuntimeEffect, type RuntimeEvent, type RuntimeSignal, type RuntimeRecord } from "./types";

type DataRow = { data: string };
type EffectRow = {
  effect_id: string; run_id: string; task_id: string | null; kind: RuntimeEffect["kind"]; effect_key: string;
  sequence: number; generation: number; attempts: number; due_at: number; data: string;
  lease_token: string | null; lease_owner: string | null; lease_generation: number | null; lease_expires_at: number | null;
};
export type EffectInput = Pick<RuntimeEffect, "runId" | "kind" | "key" | "data"> & { taskId?: string; dueAt: number };
export type StoreLimits = { maxEffects: number; maxEffectsPerRun: number; maxActiveRuns: number };

/** Internal persistence boundary. No worker, model, tool, IPC or automatic recovery is started here. */
export class RuntimeStore {
  readonly #db: Database;
  readonly #limits: StoreLimits;
  #closed = false;

  constructor(readonly path: string, limits: Partial<StoreLimits> = {}) {
    this.#limits = { maxEffects: limits.maxEffects ?? 256, maxEffectsPerRun: limits.maxEffectsPerRun ?? 64, maxActiveRuns: limits.maxActiveRuns ?? 64 };
    integer(this.#limits.maxEffects, "effect queue capacity", 1);
    integer(this.#limits.maxEffectsPerRun, "run effect queue capacity", 1);
    integer(this.#limits.maxActiveRuns, "active run capacity", 1);
    if (path !== ":memory:") {
      const target = resolve(path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const file = openSync(target, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try { if (!fstatSync(file).isFile()) throw new Error("Runtime database must be a regular file"); }
      finally { closeSync(file); }
      chmodSync(target, 0o600);
    }
    this.#db = new Database(path, { create: true, strict: true });
    try {
      this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;");
      migrateRuntime(this.#db);
      if (path !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL;");
    } catch (error) { this.#db.close(); throw error; }
  }

  close(): void { if (!this.#closed) { this.#db.close(); this.#closed = true; } }
  snapshot(): Uint8Array {
    return this.#write(() => {
      // serialize includes committed WAL pages. The standalone image has no WAL/SHM;
      // use rollback-journal read/write header versions so SQLite can open it independently.
      const bytes = Buffer.from(this.#db.serialize()); bytes[18] = 1; bytes[19] = 1; return bytes;
    });
  }
  deleteTerminalRun(runId: string): string[] {
    return this.#write(() => {
      const run = this.getRun(runId);
      if (!run || !["succeeded", "failed", "cancelled"].includes(run.status)) throw new Error("Only terminal Runs can be pruned");
      if (this.#reader().activeAttempts(runId).length || this.operationHeaders(runId).some((row) => row.effectOutcome === "unknown" || row.state === "dispatched")) throw new Error("Run still has unreconciled execution evidence");
      const taskIds = this.tasks(runId).map((task) => task.taskId);
      this.#db.query("DELETE FROM task_dependencies WHERE task_id IN (SELECT task_id FROM tasks WHERE run_id = ?)").run(runId);
      this.#db.query("DELETE FROM attempts WHERE task_id IN (SELECT task_id FROM tasks WHERE run_id = ?)").run(runId);
      for (const table of ["runtime_records", "effects", "events", "signals"]) this.#db.query(`DELETE FROM ${table} WHERE run_id = ?`).run(runId);
      // Self-referencing task edges are checked at statement end, so deleting the complete Run is atomic.
      this.#db.query("DELETE FROM tasks WHERE run_id = ?").run(runId);
      this.#db.query("DELETE FROM runs WHERE run_id = ?").run(runId);
      return taskIds;
    });
  }

  getRun(runId: string): DurableRun | undefined { return this.#reader().getRun(runId); }
  runs(): DurableRun[] {
    this.#assertOpen();
    return (this.#db.query("SELECT data FROM runs ORDER BY rowid").all() as DataRow[]).map((row) => JSON.parse(row.data));
  }
  record<T>(kind: string, id: string): RuntimeRecord<T> | undefined { return this.#reader().record<T>(kind, id); }
  records<T>(kind: string, runId: string, taskId?: string): RuntimeRecord<T>[] { return this.#reader().records<T>(kind, runId, taskId); }
  operationHeaders(runId: string, taskId?: string): Array<{ id: string; taskId: string; state: string; effectOutcome?: string; name: string }> {
    this.#assertOpen();
    const rows = (this.#db.query(`SELECT record_id AS id, task_id AS taskId, json_extract(value,'$.state') AS state,
      json_extract(value,'$.effectOutcome') AS effectOutcome, json_extract(value,'$.call.name') AS name
      FROM runtime_records WHERE kind = 'operation' AND run_id = ? AND (? IS NULL OR task_id = ?) ORDER BY rowid LIMIT 10001`)
      .all(runId, taskId ?? null, taskId ?? null) as Array<{ id: string; taskId: string; state: string; effectOutcome?: string; name: string }>);
    if (rows.length > 10000) throw new Error("Runtime operation inventory exceeds supported limit");
    return rows;
  }
  getTask(taskId: string): DurableTask | undefined { return this.#reader().getTask(taskId); }
  tasks(runId: string): DurableTask[] { return this.#reader().tasks(runId); }
  getAttempt(attemptId: string): DurableAttempt | undefined { return this.#reader().getAttempt(attemptId); }
  activeAttempts(runId: string): DurableAttempt[] { return this.#reader().activeAttempts(runId); }
  getSignal(runId: string, kind: RuntimeSignal["kind"], key: string): RuntimeSignal | undefined {
    return this.#reader().getSignal(runId, kind, key);
  }
  events(runId: string, afterSequence = 0, limit = 100): RuntimeEvent[] {
    integer(afterSequence, "event cursor"); integer(limit, "event page size", 1, 1000);
    this.#assertOpen();
    return (this.#db.query("SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?")
      .all(runId, afterSequence, limit) as Array<{ event_id: string; run_id: string; sequence: number; command_id: string; type: string; task_id: string | null; at: number; data: string }>).map((row) => ({
      eventId: row.event_id, runId: row.run_id, sequence: row.sequence, commandId: row.command_id,
      type: row.type, ...(row.task_id ? { taskId: row.task_id } : {}), at: row.at, data: JSON.parse(row.data),
    }));
  }
  effects(runId: string): RuntimeEffect[] {
    this.#assertOpen();
    return (this.#db.query("SELECT * FROM effects WHERE run_id = ? ORDER BY sequence").all(runId) as EffectRow[]).map(effectFromRow);
  }
  /** Only the exclusive service owner may reclaim dispatch leases left by a dead owner. */
  reclaimEffects(ownerId: string): void {
    this.#write(() => this.#db.query("UPDATE effects SET lease_token = NULL, lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL WHERE lease_owner IS NOT NULL AND lease_owner <> ?").run(ownerId));
  }
  artifactReferences(): Set<string> {
    this.#assertOpen(); const references = new Set<string>();
    for (const query of ["SELECT data AS value FROM tasks", "SELECT data AS value FROM events", "SELECT value FROM runtime_records"]) {
      for (const row of this.#db.query(query).iterate() as Iterable<{ value: string }>) {
        for (const match of row.value.matchAll(/[a-f0-9]{64}/g)) references.add(match[0]);
      }
    }
    return references;
  }
  compact(): void {
    this.#assertOpen(); this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
  }

  /** A successful receipt, state, events and effects commit together. Failed commands have no receipt. */
  command<T>(commandId: string, input: unknown, now: number, apply: (tx: RuntimeTransaction) => T): T {
    text(commandId, "command ID", 128); integer(now, "command time");
    const digest = digestJson({ version: 1, input }, 256 * 1024);
    return this.#write(() => {
      const receipt = this.#db.query("SELECT digest, result FROM commands WHERE command_id = ?").get(commandId) as { digest: string; result: string } | null;
      if (receipt) {
        if (receipt.digest !== digest) throw new Error("Command ID was already used with different input");
        return JSON.parse(receipt.result) as T;
      }
      const tx = new RuntimeTransaction(this.#db, this.#limits, commandId, now);
      let result: T;
      try { result = apply(tx); }
      finally { tx.expire(); }
      if (result && typeof (result as { then?: unknown }).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error("Runtime transactions must be synchronous");
      }
      const encoded = encodeJson(result);
      this.#db.query("INSERT INTO commands(command_id, digest, result, committed_at) VALUES (?, ?, ?, ?)").run(commandId, digest, encoded, now);
      return JSON.parse(encoded) as T;
    });
  }

  /** Storage leases only. Claiming a row does not authorize its effect or execute it. */
  claimEffects(input: { ownerId: string; now: number; leaseMs: number; limit?: number }): RuntimeEffect[] {
    text(input.ownerId, "effect owner", 128); integer(input.now, "claim time"); integer(input.leaseMs, "effect lease", 1, 600_000);
    const limit = integer(input.limit ?? 1, "effect claim limit", 1, 256);
    const expires = integer(input.now + input.leaseMs, "effect lease expiry");
    return this.#write(() => {
      const rows = this.#db.query(`SELECT e.* FROM effects e JOIN runs r ON r.run_id = e.run_id
        WHERE e.due_at <= ? AND (e.lease_token IS NULL OR e.lease_expires_at <= ?)
        AND (e.kind = 'control' OR r.status = 'active') ORDER BY e.sequence LIMIT ?`).all(input.now, input.now, limit) as EffectRow[];
      return rows.map((row) => {
        const token = randomUUID();
        this.#db.query("UPDATE effects SET lease_token = ?, lease_owner = ?, lease_generation = generation, lease_expires_at = ? WHERE effect_id = ?")
          .run(token, input.ownerId, expires, row.effect_id);
        return effectFromRow({ ...row, lease_token: token, lease_owner: input.ownerId, lease_generation: row.generation, lease_expires_at: expires });
      });
    });
  }

  settleEffect(effectId: string, leaseToken: string, now: number, retryAt?: number): "settled" | "superseded" | "stale" {
    integer(now, "effect settlement time");
    if (retryAt !== undefined) integer(retryAt, "effect retry time", now + 1);
    return this.#write(() => {
      const row = this.#db.query("SELECT * FROM effects WHERE effect_id = ?").get(effectId) as EffectRow | null;
      if (!row || row.lease_token !== leaseToken || row.lease_expires_at! <= now) return "stale";
      if (row.generation !== row.lease_generation) {
        this.#clearEffectLease(effectId);
        return "superseded";
      }
      if (retryAt === undefined) this.#db.query("DELETE FROM effects WHERE effect_id = ?").run(effectId);
      else {
        this.#db.query("UPDATE effects SET attempts = attempts + 1, due_at = ? WHERE effect_id = ?").run(retryAt, effectId);
        this.#clearEffectLease(effectId);
      }
      return "settled";
    });
  }

  #clearEffectLease(effectId: string): void {
    this.#db.query("UPDATE effects SET lease_token = NULL, lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL WHERE effect_id = ?").run(effectId);
  }
  #reader(): RuntimeTransaction { this.#assertOpen(); return new RuntimeTransaction(this.#db, this.#limits, "", 0); }
  #assertOpen(): void { if (this.#closed) throw new Error("Runtime store is closed"); }
  #write<T>(apply: () => T): T { this.#assertOpen(); return this.#db.transaction(apply).immediate(); }
}

/** Only handed to internal synchronous command handlers; not an RPC or authorization API. */
export class RuntimeTransaction {
  #expired = false;
  constructor(private readonly db: Database, private readonly limits: StoreLimits, readonly commandId: string, readonly now: number) {}
  expire(): void { this.#expired = true; }

  getRun(id: string): DurableRun | undefined { return this.#read<DurableRun>("SELECT data FROM runs WHERE run_id = ?", id); }
  getTask(id: string): DurableTask | undefined { return this.#read<DurableTask>("SELECT data FROM tasks WHERE task_id = ?", id); }
  getAttempt(id: string): DurableAttempt | undefined { return this.#read<DurableAttempt>("SELECT data FROM attempts WHERE attempt_id = ?", id); }
  record<T>(kind: string, id: string): RuntimeRecord<T> | undefined {
    const row = this.db.query("SELECT * FROM runtime_records WHERE kind = ? AND record_id = ?").get(kind, id) as RecordRow | null;
    return row ? recordFromRow<T>(row) : undefined;
  }
  records<T>(kind: string, runId: string, taskId?: string): RuntimeRecord<T>[] {
    const rows = this.db.query("SELECT * FROM runtime_records WHERE kind = ? AND run_id = ? AND (? IS NULL OR task_id = ?) ORDER BY rowid LIMIT 10001")
      .all(kind, runId, taskId ?? null, taskId ?? null) as RecordRow[];
    if (rows.length > 10000) throw new Error("Runtime record collection exceeds page limit");
    return rows.map((row) => recordFromRow<T>(row));
  }
  saveRecord<T>(record: Omit<RuntimeRecord<T>, "revision">, previousRevision: number): RuntimeRecord<T> {
    this.#mutable(); integer(previousRevision, "record revision");
    text(record.kind, "record kind", 64); text(record.id, "record ID", 512);
    const value = encodeJson(record.value, 1024 * 1024);
    const revision = previousRevision + 1;
    if (previousRevision === 0) this.db.query("INSERT INTO runtime_records(kind, record_id, run_id, task_id, revision, value) VALUES (?, ?, ?, ?, ?, ?)")
      .run(record.kind, record.id, record.runId, record.taskId ?? null, revision, value);
    else {
      const result = this.db.query("UPDATE runtime_records SET revision = ?, value = ? WHERE kind = ? AND record_id = ? AND run_id = ? AND task_id IS ? AND revision = ?")
        .run(revision, value, record.kind, record.id, record.runId, record.taskId ?? null, previousRevision);
      if (result.changes !== 1) throw new Error("Runtime record revision conflict");
    }
    return { ...record, revision };
  }
  saveAttempt(attempt: DurableAttempt): void {
    this.#mutable();
    const result = this.db.query("UPDATE attempts SET data = ? WHERE attempt_id = ? AND task_id = ? AND epoch = ? AND status = 'active'")
      .run(encodeJson(attempt), attempt.attemptId, attempt.taskId, attempt.epoch);
    if (result.changes !== 1) throw new Error("Attempt is no longer active");
  }
  tasks(runId: string): DurableTask[] {
    return (this.db.query("SELECT data FROM tasks WHERE run_id = ? ORDER BY rowid").all(runId) as DataRow[]).map((row) => JSON.parse(row.data));
  }
  getSignal(runId: string, kind: RuntimeSignal["kind"], key: string): RuntimeSignal | undefined {
    const row = this.db.query("SELECT * FROM signals WHERE run_id = ? AND kind = ? AND signal_key = ?").get(runId, kind, key) as
      { generation: number; data: string; at: number } | null;
    return row ? { runId, kind, key, generation: row.generation, data: JSON.parse(row.data), at: row.at } : undefined;
  }
  insertRun(run: DurableRun): void {
    this.#mutable();
    const active = (this.db.query("SELECT COUNT(*) AS n FROM runs WHERE status NOT IN ('cancelled','succeeded','failed')").get() as { n: number }).n;
    if (active >= this.limits.maxActiveRuns) throw new Error("Runtime active run capacity is full");
    this.db.query("INSERT INTO runs(run_id, revision, status, data) VALUES (?, ?, ?, ?)").run(run.runId, run.revision, run.status, encodeJson(run));
  }
  saveRun(run: DurableRun, previousRevision: number): void {
    this.#mutable();
    if (run.revision !== previousRevision + 1) throw new Error("Run revision must advance by one");
    const result = this.db.query("UPDATE runs SET revision = ?, status = ?, data = ? WHERE run_id = ? AND revision = ?")
      .run(run.revision, run.status, encodeJson(run), run.runId, previousRevision);
    if (result.changes !== 1) throw new Error("Run revision conflict");
  }
  insertTask(task: DurableTask): void {
    this.#mutable();
    if (task.parentTaskId && this.getTask(task.parentTaskId)?.runId !== task.runId) throw new Error("Task parent belongs to another run");
    this.db.query("INSERT INTO tasks(task_id, run_id, task_key, parent_task_id, revision, status, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(task.taskId, task.runId, task.key, task.parentTaskId ?? null, task.revision, task.status, encodeJson(task));
  }
  addDependency(taskId: string, dependencyId: string): void {
    this.#mutable();
    if (!this.getTask(taskId) || this.getTask(taskId)?.runId !== this.getTask(dependencyId)?.runId) throw new Error("Invalid task dependency");
    this.db.query("INSERT INTO task_dependencies(task_id, dependency_id) VALUES (?, ?)").run(taskId, dependencyId);
  }
  saveTask(task: DurableTask, previousRevision: number): void {
    this.#mutable();
    const existing = this.getTask(task.taskId);
    if (!existing || existing.revision !== previousRevision) throw new Error("Task revision conflict");
    if (task.revision !== previousRevision + 1) throw new Error("Task revision must advance by one");
    if (task.runId !== existing.runId || task.key !== existing.key || task.parentTaskId !== existing.parentTaskId
      || task.inputDigest !== existing.inputDigest || encodeJson(task.dependsOn) !== encodeJson(existing.dependsOn)) {
      throw new Error("Task identity and inputs cannot change through a state transition");
    }
    if (task.status !== existing.status) assertTaskTransition(existing.status, task.status);
    const result = this.db.query("UPDATE tasks SET revision = ?, status = ?, data = ? WHERE task_id = ? AND revision = ?")
      .run(task.revision, task.status, encodeJson(task), task.taskId, previousRevision);
    if (result.changes !== 1) throw new Error("Task revision conflict");
  }
  insertAttempt(attempt: DurableAttempt): void {
    this.#mutable(); this.db.query("INSERT INTO attempts(attempt_id, task_id, epoch, status, data) VALUES (?, ?, ?, ?, ?)")
      .run(attempt.attemptId, attempt.taskId, attempt.epoch, attempt.status, encodeJson(attempt));
  }
  endAttempt(attempt: DurableAttempt): void {
    this.#mutable();
    const ended = { ...attempt, status: "ended", endedAt: this.now };
    const result = this.db.query("UPDATE attempts SET status = 'ended', data = ? WHERE attempt_id = ? AND status = 'active'")
      .run(encodeJson(ended), attempt.attemptId);
    if (result.changes !== 1) throw new Error("Attempt is no longer active");
  }
  activeAttempts(runId: string): DurableAttempt[] {
    return (this.db.query("SELECT a.data FROM attempts a JOIN tasks t ON t.task_id = a.task_id WHERE t.run_id = ? AND a.status = 'active'")
      .all(runId) as DataRow[]).map((row) => JSON.parse(row.data));
  }
  signal(runId: string, kind: RuntimeSignal["kind"], key: string, data: unknown): RuntimeSignal {
    this.#mutable();
    const generation = (this.getSignal(runId, kind, key)?.generation ?? 0) + 1;
    this.db.query(`INSERT INTO signals(run_id, kind, signal_key, generation, data, at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, kind, signal_key) DO UPDATE SET generation = excluded.generation, data = excluded.data, at = excluded.at`)
      .run(runId, kind, key, generation, encodeJson(data, 16 * 1024), this.now);
    return { runId, kind, key, generation, data, at: this.now };
  }
  event(runId: string, type: string, data: unknown, taskId?: string): void {
    this.#mutable();
    const sequence = (this.db.query("SELECT COALESCE(MAX(sequence), 0) AS n FROM events WHERE run_id = ?").get(runId) as { n: number }).n + 1;
    this.db.query("INSERT INTO events(event_id, run_id, sequence, command_id, type, task_id, at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), runId, sequence, this.commandId, type, taskId ?? null, this.now, encodeJson(data, 16 * 1024));
  }
  enqueue(effect: EffectInput): void {
    this.#mutable(); text(effect.key, "effect key", 256); integer(effect.dueAt, "effect due time");
    if (effect.taskId && this.getTask(effect.taskId)?.runId !== effect.runId) throw new Error("Effect task belongs to another run");
    if (effect.kind === "control" && effect.key !== "run-control") throw new Error("Control effects must coalesce per run");
    const existing = this.db.query("SELECT effect_id FROM effects WHERE run_id = ? AND kind = ? AND effect_key = ?")
      .get(effect.runId, effect.kind, effect.key);
    // One reserved control row per admitted Run keeps pause/cancel possible at a full business queue.
    if (!existing && effect.kind !== "control") {
      const counts = this.db.query("SELECT COUNT(*) AS total, COUNT(CASE WHEN run_id = ? THEN 1 END) AS per_run FROM effects WHERE kind <> 'control'")
        .get(effect.runId) as { total: number; per_run: number };
      if (counts.total >= this.limits.maxEffects || counts.per_run >= this.limits.maxEffectsPerRun) throw new Error("Runtime effect queue is full");
    }
    this.db.query(`INSERT INTO effects(effect_id, run_id, task_id, kind, effect_key, generation, due_at, data) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(run_id, kind, effect_key) DO UPDATE SET generation = effects.generation + 1, task_id = excluded.task_id,
        data = excluded.data, due_at = excluded.due_at, attempts = 0`)
      .run(randomUUID(), effect.runId, effect.taskId ?? null, effect.kind, effect.key, effect.dueAt, encodeJson(effect.data, 16 * 1024));
  }
  #mutable(): void { if (!this.commandId || this.#expired) throw new Error("Runtime transaction is no longer writable"); }
  #read<T>(sql: string, key: string): T | undefined {
    const row = this.db.query(sql).get(key) as DataRow | null;
    return row ? JSON.parse(row.data) as T : undefined;
  }
}

function effectFromRow(row: EffectRow): RuntimeEffect {
  return {
    effectId: row.effect_id, runId: row.run_id, ...(row.task_id ? { taskId: row.task_id } : {}),
    kind: row.kind, key: row.effect_key, sequence: row.sequence, generation: row.generation,
    attempts: row.attempts, dueAt: row.due_at, data: JSON.parse(row.data),
    ...(row.lease_token ? { leaseToken: row.lease_token, leaseOwner: row.lease_owner!, leaseGeneration: row.lease_generation!, leaseExpiresAt: row.lease_expires_at! } : {}),
  };
}

type RecordRow = { kind: string; record_id: string; run_id: string; task_id: string | null; revision: number; value: string };
function recordFromRow<T>(row: RecordRow): RuntimeRecord<T> {
  return { kind: row.kind, id: row.record_id, runId: row.run_id, ...(row.task_id ? { taskId: row.task_id } : {}), revision: row.revision, value: JSON.parse(row.value) };
}
