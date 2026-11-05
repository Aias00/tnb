import type { Database } from "bun:sqlite";

export const RUNTIME_SCHEMA_VERSION = 5;
const RUNTIME_APPLICATION_ID = 0x544e4252; // TNBR

export function migrateRuntime(database: Database): void {
  database.transaction(() => {
    // Read the version after obtaining the write lock: another opener may have just migrated it.
    const version = (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > RUNTIME_SCHEMA_VERSION) throw new Error(`Unsupported runtime schema version: ${version}`);
    const application = (database.query("PRAGMA application_id").get() as { application_id: number }).application_id;
    if (version === RUNTIME_SCHEMA_VERSION) {
      if (application !== RUNTIME_APPLICATION_ID) throw new Error("Unrecognized runtime database identity");
      return;
    }
    if (version >= 1 && version <= 4 && application === RUNTIME_APPLICATION_ID) {
      if (version === 1) addRecords(database);
      if (version <= 2) addRouting(database);
      if (version <= 3) addRoutingTombstones(database);
      addApplicationRecords(database);
      return;
    }
    if (version === 1) throw new Error("Unrecognized runtime database identity");
    if (application !== 0 || version !== 0 || database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
      throw new Error("Unrecognized runtime database; migration refused");
    }
    database.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK(revision > 0),
        status TEXT NOT NULL CHECK(status IN ('active','pausing','paused','cancelling','cancelled','succeeded','failed')),
        data TEXT NOT NULL CHECK(json_valid(data)),
        CHECK(json_extract(data, '$.runId') IS run_id AND json_extract(data, '$.revision') IS revision AND json_extract(data, '$.status') IS status)
      );
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        task_key TEXT NOT NULL,
        parent_task_id TEXT REFERENCES tasks(task_id),
        revision INTEGER NOT NULL CHECK(revision > 0),
        status TEXT NOT NULL CHECK(status IN ('pending','ready','running','waiting','reconciling','validating','paused','succeeded','failed','cancelled')),
        data TEXT NOT NULL CHECK(json_valid(data)),
        UNIQUE(run_id, task_key),
        UNIQUE(run_id, task_id),
        FOREIGN KEY(run_id, parent_task_id) REFERENCES tasks(run_id, task_id),
        CHECK(parent_task_id IS NULL OR parent_task_id <> task_id),
        CHECK(json_extract(data, '$.taskId') IS task_id AND json_extract(data, '$.runId') IS run_id
          AND json_extract(data, '$.key') IS task_key AND json_extract(data, '$.revision') IS revision AND json_extract(data, '$.status') IS status)
      );
      CREATE INDEX tasks_run_status ON tasks(run_id, status);
      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        dependency_id TEXT NOT NULL REFERENCES tasks(task_id),
        PRIMARY KEY(task_id, dependency_id),
        CHECK(task_id <> dependency_id)
      );
      CREATE TABLE attempts (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        epoch INTEGER NOT NULL CHECK(epoch > 0),
        status TEXT NOT NULL CHECK(status IN ('active','ended')),
        data TEXT NOT NULL CHECK(json_valid(data)),
        UNIQUE(task_id, epoch),
        CHECK(json_extract(data, '$.attemptId') IS attempt_id AND json_extract(data, '$.taskId') IS task_id
          AND json_extract(data, '$.epoch') IS epoch AND json_extract(data, '$.status') IS status)
      );
      CREATE UNIQUE INDEX one_active_attempt ON attempts(task_id) WHERE status = 'active';
      CREATE TABLE commands (
        command_id TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        result TEXT NOT NULL CHECK(json_valid(result)),
        committed_at INTEGER NOT NULL
      );
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        command_id TEXT NOT NULL,
        type TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(task_id),
        at INTEGER NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)),
        UNIQUE(run_id, sequence),
        FOREIGN KEY(run_id, task_id) REFERENCES tasks(run_id, task_id)
      );
      CREATE TABLE signals (
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        kind TEXT NOT NULL CHECK(kind IN ('message','approval','timer','resource')),
        signal_key TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation > 0),
        data TEXT NOT NULL CHECK(json_valid(data)),
        at INTEGER NOT NULL,
        PRIMARY KEY(run_id, kind, signal_key)
      );
      CREATE TABLE effects (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        effect_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        task_id TEXT REFERENCES tasks(task_id),
        kind TEXT NOT NULL CHECK(kind IN ('schedule','wake','control')),
        effect_key TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation > 0),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        due_at INTEGER NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)),
        lease_token TEXT,
        lease_owner TEXT,
        lease_generation INTEGER,
        lease_expires_at INTEGER,
        UNIQUE(run_id, kind, effect_key),
        FOREIGN KEY(run_id, task_id) REFERENCES tasks(run_id, task_id),
        CHECK(kind <> 'control' OR effect_key = 'run-control'),
        CHECK((lease_token IS NULL AND lease_owner IS NULL AND lease_generation IS NULL AND lease_expires_at IS NULL)
          OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_generation IS NOT NULL AND lease_expires_at IS NOT NULL))
      );
      CREATE INDEX effects_due ON effects(due_at, sequence);
      PRAGMA user_version = 1;
      PRAGMA application_id = ${RUNTIME_APPLICATION_ID};
    `);
    addRecords(database);
    addRouting(database);
    addRoutingTombstones(database);
    addApplicationRecords(database);
  }).immediate();
}

function addRouting(database: Database): void {
  database.exec(`CREATE TABLE routing_inputs (
    input_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
  ); CREATE INDEX routing_by_workspace ON routing_inputs(workspace); PRAGMA user_version = 3;`);
}

function addRoutingTombstones(database: Database): void {
  database.exec(`CREATE TABLE routing_tombstones (input_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, digest TEXT NOT NULL);
    CREATE INDEX routing_pending ON routing_inputs(workspace, json_extract(data,'$.status'));
    PRAGMA user_version = 4;`);
}

function addRecords(database: Database): void {
  database.exec(`CREATE TABLE runtime_records (
    kind TEXT NOT NULL, record_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(run_id),
    task_id TEXT, revision INTEGER NOT NULL CHECK(revision > 0), value TEXT NOT NULL CHECK(json_valid(value)),
    PRIMARY KEY(kind, record_id), FOREIGN KEY(run_id, task_id) REFERENCES tasks(run_id, task_id)
  ); CREATE INDEX records_by_run ON runtime_records(kind, run_id); PRAGMA user_version = 2;`);
}

/** Application facts can exist before a Run is admitted; linked Runs remain protected from pruning. */
function addApplicationRecords(database: Database): void {
  database.exec(`CREATE TABLE application_records (
    namespace TEXT NOT NULL, record_id TEXT NOT NULL, run_id TEXT REFERENCES runs(run_id),
    revision INTEGER NOT NULL CHECK(revision > 0), value TEXT NOT NULL CHECK(json_valid(value)),
    PRIMARY KEY(namespace, record_id)
  ); CREATE INDEX application_by_run ON application_records(run_id);
  CREATE INDEX application_by_state ON application_records(namespace,json_extract(value,'$.state'),record_id); PRAGMA user_version = 5;`);
}
