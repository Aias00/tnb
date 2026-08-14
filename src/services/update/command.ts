import { createHash } from "node:crypto";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

type Writer = { write(text: string): unknown };
type ReleaseManifest = { version: string; url: string; sha256: string; notes?: string };

export async function runUpdateCommand(options: {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: Writer;
  stderr: Writer;
  currentVersion: string;
  executable: string;
}): Promise<number> {
  try {
    if (options.argv.includes("--help") || options.argv.includes("-h")) {
      options.stdout.write(`Usage: tnb update [--check] [--yes] [--rollback]

Reads a JSON release manifest from TNB_UPDATE_MANIFEST_URL. The manifest
must contain version, url, and sha256. Installing requires --yes and atomically
keeps the previous executable as <binary>.previous. --rollback atomically swaps
the current and previous binaries without contacting the release server.
`);
      return 0;
    }
    if (options.argv.includes("--rollback")) {
      const executable = updateExecutable(options);
      const previous = `${executable}.previous`;
      const temporary = join(dirname(executable), `.${basename(executable)}.${process.pid}.rollback`);
      await rename(executable, temporary);
      try {
        await rename(previous, executable);
        await rename(temporary, previous);
      } catch (error) {
        await rename(temporary, executable).catch(() => undefined);
        throw error;
      }
      options.stdout.write(`Rolled back tnb. Replaced binary retained at ${previous}\n`);
      return 0;
    }
    const manifestUrl = options.env.TNB_UPDATE_MANIFEST_URL;
    if (!manifestUrl) throw new Error("TNB_UPDATE_MANIFEST_URL is required");
    const manifest = await fetchManifest(manifestUrl);
    const available = compareVersions(manifest.version, options.currentVersion) > 0;
    if (options.argv.includes("--check") || !available) {
      options.stdout.write(available
        ? `Update available: ${options.currentVersion} -> ${manifest.version}${manifest.notes ? `\n${manifest.notes}` : ""}\n`
        : `tnb ${options.currentVersion} is up to date.\n`);
      return 0;
    }
    if (!options.argv.includes("--yes")) {
      throw new Error(`Update ${options.currentVersion} -> ${manifest.version} requires --yes`);
    }
    const executable = updateExecutable(options);
    const response = await fetch(new URL(manifest.url));
    if (!response.ok) throw new Error(`Update download returned ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash.toLowerCase() !== manifest.sha256.toLowerCase()) {
      throw new Error(`Update checksum mismatch: expected ${manifest.sha256}, received ${actualHash}`);
    }
    const temporary = join(dirname(executable), `.${basename(executable)}.${process.pid}.update`);
    const previous = `${executable}.previous`;
    await writeFile(temporary, bytes, { mode: 0o755 });
    await chmod(temporary, 0o755);
    await unlink(previous).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
    await rename(executable, previous);
    try {
      await rename(temporary, executable);
    } catch (error) {
      await rename(previous, executable).catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    options.stdout.write(`Updated tnb to ${manifest.version}. Previous binary: ${previous}\n`);
    return 0;
  } catch (error) {
    options.stderr.write(`tnb: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function updateExecutable(options: {
  env: Record<string, string | undefined>;
  executable: string;
}): string {
  const explicitExecutable = options.env.TNB_EXECUTABLE;
  const executable = resolve(explicitExecutable ?? options.executable);
  if (!explicitExecutable && !basename(executable).startsWith("tnb")) {
    throw new Error("Self-update is available only from a compiled tnb binary; set TNB_EXECUTABLE explicitly to override");
  }
  return executable;
}

async function fetchManifest(value: string): Promise<ReleaseManifest> {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("TNB_UPDATE_MANIFEST_URL must use HTTP or HTTPS");
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Update manifest returned ${response.status}`);
  const valueObject: unknown = await response.json();
  if (!valueObject || typeof valueObject !== "object" || Array.isArray(valueObject)) {
    throw new Error("Update manifest must be a JSON object");
  }
  const record = valueObject as Record<string, unknown>;
  if (typeof record.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(record.version)) {
    throw new Error("Update manifest version must be semantic version text");
  }
  if (typeof record.url !== "string" || !/^https?:\/\//.test(record.url)) {
    throw new Error("Update manifest url must use HTTP or HTTPS");
  }
  if (typeof record.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(record.sha256)) {
    throw new Error("Update manifest sha256 must contain 64 hexadecimal characters");
  }
  return {
    version: record.version,
    url: record.url,
    sha256: record.sha256,
    ...(typeof record.notes === "string" && record.notes.trim() ? { notes: record.notes.trim() } : {}),
  };
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(/[+-]/, 1)[0]!.split(".").map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
