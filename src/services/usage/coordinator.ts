import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

/** Same-user cooperative coordination, independent of TNB_HOME. Never carries provider credentials. */
export function coordinatorDirectory(): string {
  return join(process.platform === "win32" ? tmpdir() : "/tmp", `tnb-coordinator-${process.getuid?.() ?? "local"}`);
}
export function openCoordinator(directory = coordinatorDirectory()): Database {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid?.()))) throw new Error("Unsafe coordinator directory");
  const path = join(directory, "leases.sqlite");
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { const file = fstatSync(fd); if (!file.isFile() || (process.platform !== "win32" && ((file.mode & 0o077) || file.uid !== process.getuid?.()))) throw new Error("Unsafe coordinator database"); }
  finally { closeSync(fd); }
  const db = new Database(path, { create: true });
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,path TEXT NOT NULL,pid INTEGER NOT NULL,owner TEXT,born TEXT);
    CREATE TABLE IF NOT EXISTS slots(id TEXT PRIMARY KEY,domain TEXT NOT NULL,project TEXT NOT NULL,pid INTEGER NOT NULL,state TEXT NOT NULL,queued INTEGER NOT NULL,born TEXT);
    CREATE TABLE IF NOT EXISTS project_grants(domain TEXT NOT NULL,project TEXT NOT NULL,last_grant INTEGER NOT NULL,PRIMARY KEY(domain,project));`);
  if (!(db.query("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).some((column) => column.name === "owner")) {
    db.transaction(() => {
      if (!(db.query("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).some((column) => column.name === "owner")) db.exec("ALTER TABLE workspaces ADD COLUMN owner TEXT");
    }).immediate();
  }
  db.transaction(() => {
    for (const table of ["workspaces", "slots"]) if (!(db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((column) => column.name === "born")) db.exec(`ALTER TABLE ${table} ADD COLUMN born TEXT`);
  }).immediate();
  return db;
}
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
const births = new Map<number, { at: number; value: string | null }>();
export function processBirth(pid: number, refresh = false): string | null {
  const cached = births.get(pid);
  if (!refresh && cached && Date.now() - cached.at < 1000) return cached.value;
  let value: string | null = null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() + ":" + stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    } else if (process.platform === "darwin") {
      const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1000, env: { LC_ALL: "C", LANG: "C", TZ: "UTC" } });
      if (result.status === 0 && result.stdout.trim()) value = result.stdout.trim();
    }
  } catch { /* An unverifiable live owner is retained, never assumed dead. */ }
  if (births.size > 512) births.clear();
  births.set(pid, { at: Date.now(), value }); return value;
}
export function cleanDeadLeases(db: Database): void {
  for (const table of ["workspaces", "slots"]) {
    const owners = db.query(`SELECT DISTINCT pid,born FROM ${table}`).all() as Array<{ pid: number; born: string | null }>;
    for (const { pid, born } of owners) {
      if (!processAlive(pid)) db.query(`DELETE FROM ${table} WHERE pid=?`).run(pid);
      else if (born) {
        const current = processBirth(pid);
        if (current && current !== born) {
          const refreshed = processBirth(pid, true);
          if (refreshed && refreshed !== born) db.query(`DELETE FROM ${table} WHERE pid=? AND born=?`).run(pid, born);
        }
      }
    }
  }
  db.exec(`DELETE FROM project_grants WHERE rowid IN (SELECT g.rowid FROM project_grants g WHERE NOT EXISTS
    (SELECT 1 FROM slots s WHERE s.domain=g.domain AND s.project=g.project) ORDER BY last_grant DESC LIMIT -1 OFFSET 10000)`);
}
export function pathsOverlap(a: string, b: string): boolean {
  if (process.platform === "win32") { a = a.toLowerCase(); b = b.toLowerCase(); }
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep) || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

export class ModelRequestCoordinator {
  constructor(readonly options: { directory?: string; perDomain?: number; total?: number; queueLimit?: number } = {}) {}
  async acquire(domain: string, project: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    const db = openCoordinator(this.options.directory); const id = randomUUID(); let acquired = false;
    try {
      db.transaction(() => {
        cleanDeadLeases(db);
        if ((db.query("SELECT COUNT(*) AS n FROM slots WHERE state='waiting'").get() as { n: number }).n >= (this.options.queueLimit ?? 256)) throw new Error("Machine model request queue is full");
        db.query("INSERT INTO slots(id,domain,project,pid,state,queued,born) VALUES(?,?,?,?,?,?,?)").run(id, domain, project, process.pid, "waiting", Date.now(), processBirth(process.pid));
      }).immediate();
      while (!acquired) {
        signal.throwIfAborted();
        acquired = db.transaction(() => {
          cleanDeadLeases(db);
          const active = db.query("SELECT domain,COUNT(*) AS n FROM slots WHERE state='active' GROUP BY domain").all() as Array<{ domain: string; n: number }>;
          if (active.reduce((sum, row) => sum + row.n, 0) >= (this.options.total ?? 8)
            || (active.find((row) => row.domain === domain)?.n ?? 0) >= (this.options.perDomain ?? 4)) return false;
          const next = db.query(`SELECT s.id FROM slots s LEFT JOIN project_grants g ON g.domain=s.domain AND g.project=s.project
            WHERE s.state='waiting' AND s.domain=? ORDER BY
            (SELECT COUNT(*) FROM slots a WHERE a.state='active' AND a.domain=s.domain AND a.project=s.project),
            COALESCE(g.last_grant,0),s.queued,s.rowid LIMIT 1`).get(domain) as { id: string } | null;
          if (next?.id !== id) return false;
          db.query("UPDATE slots SET state='active' WHERE id=?").run(id);
          db.query("INSERT INTO project_grants VALUES(?,?,?) ON CONFLICT(domain,project) DO UPDATE SET last_grant=excluded.last_grant").run(domain, project, Date.now());
          return true;
        }).immediate();
        if (!acquired) await new Promise<void>((resolve, reject) => {
          const aborted = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, 75);
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) { signal.removeEventListener("abort", aborted); aborted(); }
        });
      }
      let released = false;
      return () => { if (!released) { released = true; try { db.query("DELETE FROM slots WHERE id=?").run(id); } finally { db.close(); } } };
    } catch (error) { try { db.query("DELETE FROM slots WHERE id=?").run(id); } finally { db.close(); } throw error; }
  }
}
