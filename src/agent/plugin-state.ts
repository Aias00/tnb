import type { AdapterPluginIdentity } from "./domain";
import type { ExtensionState, PluginStateMigration, PluginMigrationTransaction } from "./extensions";
import type { PluginStateContract } from "./plugin-data";
import { PluginDataError, version } from "./plugin-data";
import type { RuntimeStore } from "../services/runtime/store";
import { digestJson, encodeJson, text } from "../services/runtime/json";

const metadata = "host.plugin-state-schema";
type StateVersion = { protocol: 1; version: number; plugin: AdapterPluginIdentity };
export function bindPluginMigrations(contract: PluginStateContract | undefined, steps: readonly PluginStateMigration[] = []): readonly PluginStateMigration[] {
  const expected = contract?.migrations ?? [];
  if (steps.length !== expected.length || new Set(steps.map(step => step.from)).size !== steps.length
    || steps.some(step => !expected.some(row => row.from === step.from && row.to === step.to) || typeof step.migrate !== "function" || step.migrate.constructor.name === "AsyncFunction")) throw new Error("Plugin migrations must synchronously implement exactly the declared from/to steps");
  return Object.freeze(steps.map(step => Object.freeze({ from: step.from, to: step.to, migrate: step.migrate.bind(step) })));
}

/** Record-only migration. Version and records commit together under the Runtime owner lock. */
export function preparePluginState(store: RuntimeStore, namespace: string, plugin: AdapterPluginIdentity, contract: PluginStateContract | undefined,
  steps: readonly PluginStateMigration[], signal: AbortSignal, report: (state: NonNullable<ExtensionState["state"]>) => void): void {
  const previous = store.applicationRecord<StateVersion>(metadata, namespace);
  let current = previous?.value?.version ?? 0;
  const fail = (message: string): never => { report({ status: "blocked", version: current, ...(contract ? { target: contract.version } : {}) }); throw new PluginDataError("PLUGIN_STATE_INCOMPATIBLE", message); };
  if (previous && (!previous.value || previous.value.protocol !== 1 || !version(current))) fail("invalid persisted schema metadata");
  if (!contract) { if (previous) fail("versioned state requires a declared contract; legacy code cannot resume it"); report({ status: "legacy", version: 0 }); return; }
  const saveVersion = (version: number) => {
    const value: StateVersion = { protocol: 1, version, plugin };
    store.command(`plugin-state-init:${digestJson({ namespace, version })}`, { namespace, value }, Date.now(), tx => {
      if (tx.applicationRecord(metadata, namespace)) throw new Error("Plugin state schema changed during initialization");
      tx.saveApplicationRecord({ namespace: metadata, id: namespace, value }, 0); return true;
    });
  };
  signal.throwIfAborted();
  if (!previous && store.applicationRecords(namespace, "", 1).length === 0) { saveVersion(contract.version); current = contract.version; }
  if (current > contract.version) fail(`state version ${current} cannot downgrade to ${contract.version}`);
  // Validate the whole path before committing any step.
  const path: PluginStateMigration[] = []; let cursor = current;
  while (cursor < contract.version) {
    const step = steps.find(step => step.from === cursor);
    if (!step) return fail(`no migration path from ${current} to ${contract.version}`);
    if (step.to > contract.version || path.length >= 32) fail(`no migration path from ${current} to ${contract.version}`);
    path.push(step); cursor = step.to;
  }
  for (const step of path) {
    report({ status: "migrating", version: current, target: contract.version }); signal.throwIfAborted();
    const input = { namespace, from: step.from, to: step.to, plugin };
    try {
      store.command(`plugin-state-migrate:${digestJson({ namespace, from: step.from, to: step.to })}`, input, Date.now(), tx => {
        const before = tx.applicationRecord<StateVersion>(metadata, namespace);
        if ((before?.value.version ?? 0) !== step.from) throw new Error("Plugin schema migration revision changed");
        const records = tx.applicationRecords(namespace, "", 256);
        if (records.length === 256 && tx.applicationRecords(namespace, records.at(-1)!.id, 1).length) throw new Error("Plugin record migration exceeds 256 record limit; explicit batch protocol required");
        let bytes = records.reduce((size, row) => size + Buffer.byteLength(encodeJson(row.value, 128 * 1024)), 0), writes = 0, live = true;
        if (bytes > 4 * 1024 * 1024) throw new Error("Plugin migration exceeds 4 MiB limit");
        const assert = () => { if (!live) throw new Error("Plugin migration transaction lifetime ended"); signal.throwIfAborted(); };
        const handle: PluginMigrationTransaction = Object.freeze({
          get<T>(id: string) { assert(); return tx.applicationRecord<T>(namespace, id); },
          list<T>() { assert(); return tx.applicationRecords<T>(namespace, "", 256); },
          save<T>(id: string, value: T, revision: number) {
            assert(); text(id, "plugin migration record ID", 512);
            if (++writes > 256 || (bytes += Buffer.byteLength(encodeJson(value, 128 * 1024))) > 4 * 1024 * 1024) throw new Error("Plugin migration write budget exceeded");
            return tx.saveApplicationRecord({ namespace, id, value }, revision);
          },
        });
        try {
          const returned: unknown = step.migrate(handle);
          if (returned && typeof (returned as { then?: unknown }).then === "function") { void Promise.resolve(returned).catch(() => {}); throw new Error("Plugin migration must be synchronous"); }
          signal.throwIfAborted();
          tx.saveApplicationRecord({ namespace: metadata, id: namespace, value: { protocol: 1, version: step.to, plugin } }, before?.revision ?? 0);
          return { from: step.from, to: step.to, writes };
        } finally { live = false; }
      });
      current = step.to;
    } catch {
      report({ status: "blocked", version: current, target: contract.version });
      throw new PluginDataError("PLUGIN_STATE_MIGRATION_FAILED", `record migration ${step.from} to ${step.to} failed; original step records and version were rolled back`);
    }
  }
  report({ status: "ready", version: current, target: contract.version });
}
