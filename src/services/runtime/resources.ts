import { randomUUID } from "node:crypto";
import { openCoordinator, processAlive, processBirth } from "../usage/coordinator";
import { digestJson } from "./json";
import type { ResourceClaim } from "../../agent/domain";

/** Same-user cooperative exact resource leases, independent of control-store location. */
export function tryAcquireResources(claims: readonly ResourceClaim[], directory?: string): (() => void) | undefined {
  const db = openCoordinator(directory), lease = randomUUID();
  db.exec("CREATE TABLE IF NOT EXISTS agent_resources(lease TEXT NOT NULL,resource TEXT NOT NULL,mode TEXT NOT NULL,pid INTEGER NOT NULL,born TEXT,PRIMARY KEY(lease,resource))");
  try {
    const admitted = db.transaction(() => {
      for (const row of db.query("SELECT DISTINCT pid,born FROM agent_resources").all() as Array<{ pid: number; born: string | null }>) {
        const current = row.born && processBirth(row.pid, true);
        if (!processAlive(row.pid) || row.born && current && current !== row.born) db.query("DELETE FROM agent_resources WHERE pid=? AND born IS ?").run(row.pid, row.born);
      }
      for (const claim of claims) if (db.query("SELECT 1 FROM agent_resources WHERE resource=? AND (mode='write' OR ?='write') LIMIT 1").get(digestJson(claim.id), claim.mode)) return false;
      for (const claim of claims) db.query("INSERT INTO agent_resources VALUES(?,?,?,?,?)").run(lease, digestJson(claim.id), claim.mode, process.pid, processBirth(process.pid));
      return true;
    }).immediate();
    if (!admitted) { db.close(); return undefined; }
    let released = false;
    return () => { if (!released) { released = true; try { db.query("DELETE FROM agent_resources WHERE lease=?").run(lease); } finally { db.close(); } } };
  } catch (error) { db.close(); throw error; }
}
