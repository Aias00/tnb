import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lock } from "../../src/utils/lockfile";

test("lease renewal probes timestamp precision separately for each lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-lock-precision-"));
  const fine = join(root, "fine"), coarse = join(root, "coarse"); await writeFile(fine, ""); await writeFile(coarse, "");
  const adapter = { ...fs, utimes(path: fs.PathLike, atime: Date, mtime: Date, callback: fs.NoParamCallback) {
    const stamp = String(path).includes("coarse") ? new Date(Math.floor(mtime.getTime() / 1000) * 1000) : mtime;
    fs.utimes(path, stamp, stamp, callback);
  } };
  const compromised: Error[] = [], releases: Array<() => Promise<void>> = [];
  try {
    for (const target of [fine, coarse]) releases.push(await lock(target, { realpath: false, fs: adapter, stale: 5000, update: 1000,
      onCompromised: error => { compromised.push(error); } }));
    await Bun.sleep(2400);
    expect(compromised).toEqual([]);
    for (const release of releases.splice(0)) await release();
  } finally {
    for (const release of releases) await release().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 5000);
