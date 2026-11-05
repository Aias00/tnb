import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

declare const TNB_BUILD_SOURCE_SHA256: string | undefined;
/** Compiled hosts embed this digest; source hosts compute the same code/lockfile digest. */
export async function codingPluginFingerprint(root = resolve(import.meta.dir, "../../..")): Promise<string> {
  if (typeof TNB_BUILD_SOURCE_SHA256 === "string") return TNB_BUILD_SOURCE_SHA256;
  const hash = createHash("sha256");
  hash.update(`tnb-coding\0${Bun.version}\0${process.platform}\0${process.arch}\0`);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Source plugin fingerprint cannot include symbolic links");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) { hash.update(relative(root, path).replaceAll("\\", "/") + "\0"); hash.update(await readFile(path)); hash.update("\0"); }
    }
  };
  await visit(join(root, "src"));
  for (const name of ["package.json", "bun.lock"]) { hash.update(name + "\0"); hash.update(await readFile(join(root, name))); hash.update("\0"); }
  return hash.digest("hex");
}
