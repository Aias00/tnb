import type { CheckOptions, LockOptions, UnlockOptions } from "proper-lockfile";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

type Lockfile = typeof import("proper-lockfile");

let loaded: Lockfile | undefined;
const fileLockQueues = new Map<string, Promise<unknown>>();

function getLockfile(): Lockfile {
  if (!loaded) loaded = require("proper-lockfile") as Lockfile;
  return loaded;
}

export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>> {
  return getLockfile().lock(file, options);
}

export function lockSync(file: string, options?: LockOptions): () => void {
  return getLockfile().lockSync(file, options);
}

export function unlock(file: string, options?: UnlockOptions): Promise<void> {
  return getLockfile().unlock(file, options);
}

export function check(file: string, options?: CheckOptions): Promise<boolean> {
  return getLockfile().check(file, options);
}

export async function withFileLock<T>(
  file: string,
  operation: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const previous = fileLockQueues.get(file) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => withFileLockNow(file, operation, options));
  fileLockQueues.set(file, current);
  void current.finally(() => {
    if (fileLockQueues.get(file) === current) fileLockQueues.delete(file);
  }).catch(() => undefined);
  return current;
}

async function withFileLockNow<T>(
  file: string,
  operation: () => Promise<T>,
  options: LockOptions,
): Promise<T> {
  await mkdir(dirname(file), { recursive: true });
  const lockTarget = `${file}.lock-target`;
  const handle = await open(lockTarget, "a", 0o600);
  await handle.close();
  const release = await lock(lockTarget, {
    realpath: false,
    retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
    lockfilePath: `${file}.lock`,
    ...options,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}
