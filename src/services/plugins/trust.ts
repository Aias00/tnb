import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type PluginTrustState = "trusted" | "untrusted" | "changed";

export function pluginTrustStorePath(configDir: string): string {
  return join(configDir, "plugin-trust.json");
}

type PluginTrustRecord = {
  root: string;
  fingerprint: string;
  trustedAt: string;
};

type PluginTrustDocument = {
  version: 1;
  plugins: Record<string, PluginTrustRecord>;
};

export async function computePluginTreeSha256(root: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".tnb-provenance.json") continue;
      const path = join(directory, entry.name);
      const relativePath = path.slice(canonicalRoot.length + 1).replaceAll("\\", "/");
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Plugin content contains a symbolic link: ${relativePath}`);
      if (info.isDirectory()) {
        hash.update(`d\0${relativePath}\0`);
        await visit(path);
      } else if (info.isFile()) {
        hash.update(`f\0${relativePath}\0${info.mode & 0o111 ? "x" : "-"}\0`);
        hash.update(await readFile(path));
        hash.update("\0");
      }
    }
  };
  await visit(canonicalRoot);
  return hash.digest("hex");
}

export async function pluginTrustState(
  storePath: string,
  root: string,
  fingerprint: string,
): Promise<PluginTrustState> {
  const canonicalRoot = await realpath(root);
  const record = (await readTrustDocument(storePath)).plugins[canonicalRoot];
  if (!record) return "untrusted";
  return record.fingerprint === fingerprint ? "trusted" : "changed";
}

export async function trustPlugin(storePath: string, root: string, fingerprint?: string): Promise<PluginTrustRecord> {
  const canonicalRoot = await realpath(root);
  const document = await readTrustDocument(storePath);
  const record = {
    root: canonicalRoot,
    fingerprint: fingerprint ?? await computePluginTreeSha256(canonicalRoot),
    trustedAt: new Date().toISOString(),
  };
  document.plugins[canonicalRoot] = record;
  await writeTrustDocument(storePath, document);
  return record;
}

export async function revokePluginTrust(storePath: string, root: string): Promise<boolean> {
  const canonicalRoot = await realpath(root);
  const document = await readTrustDocument(storePath);
  if (!document.plugins[canonicalRoot]) return false;
  delete document.plugins[canonicalRoot];
  await writeTrustDocument(storePath, document);
  return true;
}

async function readTrustDocument(path: string): Promise<PluginTrustDocument> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isTrustDocument(value)) throw new Error(`Invalid plugin trust store: ${path}`);
    return value;
  } catch (error) {
    if (isMissing(error)) return { version: 1, plugins: {} };
    throw error;
  }
}

async function writeTrustDocument(path: string, document: PluginTrustDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await rm(temporary, { force: true });
}

function isTrustDocument(value: unknown): value is PluginTrustDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const document = value as Partial<PluginTrustDocument>;
  if (document.version !== 1 || typeof document.plugins !== "object" || document.plugins === null || Array.isArray(document.plugins)) return false;
  return Object.entries(document.plugins).every(([key, record]) => {
    if (typeof record !== "object" || record === null || Array.isArray(record)) return false;
    const candidate = record as Partial<PluginTrustRecord>;
    return key === candidate.root && typeof candidate.fingerprint === "string" && /^[a-f0-9]{64}$/.test(candidate.fingerprint) && typeof candidate.trustedAt === "string";
  });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
