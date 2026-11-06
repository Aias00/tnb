import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { lock } from "../../utils/lockfile";

async function linkTarget(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) throw new Error(`Refusing to replace a non-symlink command: ${path}`);
    return resolve(dirname(path), await readlink(path));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function replaceLink(link: string, target: string) {
  const temporary = `${link}.${randomUUID()}.tmp`;
  try { await symlink(target, temporary); await rename(temporary, link); }
  finally { await rm(temporary, { force: true }); }
}
async function withInstallLock<T>(prefix: string, execute: () => Promise<T>): Promise<T> {
  const directory = join(prefix, "lib", "tnb");
  await mkdir(directory, { recursive: true });
  const unlock = await lock(directory, { realpath: true, stale: 10000, update: 2000, retries: 0 });
  try { return await execute(); } finally { await unlock(); }
}
async function assertExecutable(path: string) {
  if (!(await lstat(path)).isFile()) throw new Error(`Installed executable is not a regular file: ${path}`);
}

export async function installLocalBundle(options: { prefix: string; distribution: string; version: string; executableName: string }) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(options.version)) throw new Error("Invalid install version");
  return withInstallLock(options.prefix, async () => {
    const link = join(options.prefix, "bin", options.executableName);
    await mkdir(dirname(link), { recursive: true });
    const previous = await linkTarget(link);
    // Check rollback path before publishing anything; never overwrite an unrelated file.
    await linkTarget(`${link}.previous`);
    if (previous) await assertExecutable(previous);
    await assertExecutable(join(options.distribution, options.executableName));
    const identity = `${options.version}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const target = join(options.prefix, "lib", "tnb", identity);
    const stage = join(options.prefix, "lib", "tnb", `.install-${identity}`);
    let published = false;
    try {
      await cp(options.distribution, stage, { recursive: true, force: false });
      await assertExecutable(join(stage, options.executableName));
      await rename(stage, target);
      if (previous) await replaceLink(`${link}.previous`, previous);
      await replaceLink(link, join(target, options.executableName));
      published = true;
      return { target, link, previous };
    } finally {
      await rm(stage, { recursive: true, force: true });
      if (!published) await rm(target, { recursive: true, force: true });
    }
  });
}

export async function rollbackLocalBundle(options: { prefix: string; executableName: string }) {
  return withInstallLock(options.prefix, async () => {
    const link = join(options.prefix, "bin", options.executableName);
    const current = await linkTarget(link), previous = await linkTarget(`${link}.previous`);
    if (!current || !previous) throw new Error("No previous local installation is available");
    await assertExecutable(current); await assertExecutable(previous);
    // Current link switches atomically; a failed previous-link update never removes a bundle.
    await replaceLink(link, previous);
    try { await replaceLink(`${link}.previous`, current); }
    catch (error) { await replaceLink(link, current); throw error; }
    return { link, target: previous, previous: current };
  });
}
