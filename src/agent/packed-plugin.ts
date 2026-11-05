import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { computePluginTreeSha256 } from "../services/plugins/trust";

/** Host-supplied executable bytes. Never deserialize this from model input or a task. */
export type PackedPlugin = { fingerprint: string; files: Record<string, string> };

export async function packPlugin(directory: string): Promise<PackedPlugin> {
  const fingerprint = await computePluginTreeSha256(directory), files: Record<string, string> = {};
  const visit = async (root: string, prefix = "") => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if ([".git", ".tnb-provenance.json"].includes(entry.name)) continue;
      const name = prefix + entry.name, path = join(root, entry.name);
      if (entry.isDirectory()) await visit(path, name + "/");
      else if (entry.isFile()) files[name] = (await readFile(path)).toString("base64");
      else throw new Error("Packed plugin contains an unsupported entry");
    }
  };
  await visit(directory);
  if (await computePluginTreeSha256(directory) !== fingerprint) throw new Error("Plugin changed during packing");
  return { fingerprint, files };
}

export async function unpackPlugin(value: PackedPlugin, directory: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(value.fingerprint) || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) throw new Error("Invalid packed plugin");
  const entries = Object.entries(value.files);
  if (!entries.length || entries.length > 4096) throw new Error("Packed plugin file limit exceeded");
  let bytes = 0;
  for (const [name, encoded] of entries) {
    if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name) || name.split("/").some(part => part === "." || part === ".." || part === ".git" || part === ".tnb-provenance.json")
      || typeof encoded !== "string" || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("Invalid packed plugin file");
    const data = Buffer.from(encoded, "base64"); bytes += data.length;
    if (bytes > 32 * 1024 * 1024) throw new Error("Packed plugin byte limit exceeded");
    const path = join(directory, name); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, data, { flag: "wx", mode: 0o600 });
  }
  if (await computePluginTreeSha256(directory) !== value.fingerprint) throw new Error("Packed plugin fingerprint mismatch");
}
