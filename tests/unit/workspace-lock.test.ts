import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireWorkspace, workspaceIsLocked } from "../../src/services/runtime/workspace";
import { pathsOverlap } from "../../src/services/usage/coordinator";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
test("portable workspace leases exclude parent/child roots while allowing disjoint projects", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tnb-workspace-portable-"))); cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const a = join(root, "project"), child = join(a, "child"), b = join(root, "other"); await mkdir(child, { recursive: true }); await mkdir(b);
  const release = await acquireWorkspace(a, "first"); cleanup.push(release);
  expect(await workspaceIsLocked(child)).toBe(true);
  await expect(acquireWorkspace(child, "second")).rejects.toMatchObject({ code: "ELOCKED" });
  await expect(acquireWorkspace(root, "second")).rejects.toMatchObject({ code: "ELOCKED" });
  const independent = await acquireWorkspace(b, "independent"); await independent(); expect(await workspaceIsLocked(b)).toBe(false);
});
test.skipIf(process.platform !== "win32")("Windows drive/path case aliases cannot bypass workspace leases", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tnb-workspace-case-"))); cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const release = await acquireWorkspace(root, "original"); cleanup.push(release);
  expect(pathsOverlap(root, root.toUpperCase())).toBe(true); expect(await workspaceIsLocked(root.toUpperCase())).toBe(true);
  await expect(acquireWorkspace(root.toUpperCase(), "alias")).rejects.toMatchObject({ code: "ELOCKED" });
});
