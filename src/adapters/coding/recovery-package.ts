import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { builtinRecoveryABI } from "../../agent/builtin-generations";
import { packPlugin, type PackedPlugin } from "../../agent/packed-plugin";

declare const TNB_CODING_PACKAGE: PackedPlugin | undefined;
let cached: Promise<PackedPlugin> | undefined;
export function codingRecoveryPackage(): Promise<PackedPlugin> {
  return cached ??= typeof TNB_CODING_PACKAGE !== "undefined" ? Promise.resolve(TNB_CODING_PACKAGE) : buildCodingRecoveryPackage();
}

/** Build-time and source-host packaging share exactly the same bundle and assets. */
export async function buildCodingRecoveryPackage(root = resolve(import.meta.dir, "../../..")): Promise<PackedPlugin> {
  const directory = await mkdtemp(join(tmpdir(), "tnb-coding-package-"));
  try {
    // Bun's emitted source labels depend on cwd even with BuildConfig.root set.
    // A child keeps package bytes stable without changing the host process cwd.
    const bundle = Bun.spawn([process.execPath, "build", join(root, "src/adapters/coding/plugin-entry.ts"), "--target=bun", `--outfile=${join(directory, "index.mjs")}`],
      { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [exit, output, error] = await Promise.all([bundle.exited, new Response(bundle.stdout).text(), new Response(bundle.stderr).text()]);
    if (exit !== 0) throw new Error(`Coding recovery package failed to build: ${error || output}`);
    await writeFile(join(directory, "plugin.json"), await readFile(join(root, "src/adapters/coding/plugin.json")));
    await writeFile(join(directory, "runtime.json"), JSON.stringify(builtinRecoveryABI()));
    await mkdir(join(directory, "bundled"));
    await cp(join(root, "src/services/skills/bundled"), join(directory, "bundled"), { recursive: true });
    return await packPlugin(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
