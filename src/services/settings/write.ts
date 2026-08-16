import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "../../utils/lockfile";

export async function addProjectPermissionRule(options: {
  cwd: string;
  behavior: "allow" | "deny" | "ask";
  rule: string;
}): Promise<string> {
  const path = join(options.cwd, ".tnb", "settings.local.json");
  await withFileLock(path, async () => {
    const settings = await readObject(path);
    const permissions = objectField(settings, "permissions", path);
    const existing = permissions[options.behavior];
    if (existing !== undefined && (!Array.isArray(existing) || existing.some((value) => typeof value !== "string"))) {
      throw new Error(`permissions.${options.behavior} must be an array of strings: ${path}`);
    }
    permissions[options.behavior] = [...new Set([...(existing as string[] | undefined ?? []), options.rule])];
    settings.permissions = permissions;
    await writeObjectAtomic(path, settings);
  });
  return path;
}

export async function setUserSetting(configDir: string, key: string, value: unknown): Promise<string> {
  const path = join(configDir, "settings.json");
  await withFileLock(path, async () => {
    const settings = await readObject(path);
    settings[key] = value;
    await writeObjectAtomic(path, settings);
  });
  return path;
}

async function readObject(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Settings must be a JSON object: ${path}`);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
}

function objectField(root: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const value = root[key];
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${key} must be an object: ${path}`);
  }
  return value as Record<string, unknown>;
}

async function writeObjectAtomic(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
