import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installLocalBundle, rollbackLocalBundle } from "../../src/services/update/local-install";
import { buildInfo, sameBuild } from "../../src/services/update/build-info";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-install-")); roots.push(root);
  const prefix = join(root, "local"), distribution = join(root, "dist"); await mkdir(distribution);
  await writeFile(join(distribution, "tnb"), "first"); await writeFile(join(distribution, "companion"), "resource");
  return { prefix, distribution, executableName: "tnb", version: "0.1.0" };
}
test("same-version installs retain complete old bundles and rollback can swap both ways", async () => {
  const options = await fixture(); const first = await installLocalBundle(options);
  await writeFile(join(options.distribution, "tnb"), "second"); const second = await installLocalBundle(options);
  expect(first.target).not.toBe(second.target);
  expect(await readFile(join(first.target, "tnb"), "utf8")).toBe("first");
  expect(await readFile(join(second.target, "companion"), "utf8")).toBe("resource");
  expect(await readlink(`${second.link}.previous`)).toBe(join(first.target, "tnb"));
  await rollbackLocalBundle(options);
  expect(await readFile(second.link, "utf8")).toBe("first");
  await rollbackLocalBundle(options);
  expect(await readFile(second.link, "utf8")).toBe("second");
});
test("missing executable or missing rollback bundle leaves the current command unchanged", async () => {
  const options = await fixture(); const first = await installLocalBundle(options);
  await rm(join(options.distribution, "tnb"));
  await expect(installLocalBundle(options)).rejects.toThrow();
  expect(await readFile(first.link, "utf8")).toBe("first");
  await expect(rollbackLocalBundle(options)).rejects.toThrow("No previous");
  expect(await readFile(first.link, "utf8")).toBe("first");
});
test("installer refuses unrelated command files", async () => {
  const options = await fixture(); await mkdir(join(options.prefix, "bin"), { recursive: true });
  await writeFile(join(options.prefix, "bin", "tnb"), "unrelated");
  await expect(installLocalBundle(options)).rejects.toThrow("non-symlink");
  expect(await readFile(join(options.prefix, "bin", "tnb"), "utf8")).toBe("unrelated");
});
test("build comparison distinguishes unknown identities and actual mismatches", () => {
  const source = buildInfo(); expect(source.mode).toBe("source"); expect(sameBuild(source, {})).toBeNull();
  const compiled = { ...source, mode: "compiled" as const, sourceDigest: "a", commit: "commit" };
  expect(sameBuild(compiled, { ...compiled, builtAt: "another time" })).toBe(true);
  expect(sameBuild(compiled, { ...compiled, sourceDigest: "b" })).toBe(false);
  expect(sameBuild(compiled, undefined)).toBeNull();
});
