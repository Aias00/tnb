import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { channelRecoveryABI } from "../../agent/builtin-generations";
import { packPlugin, type PackedPlugin } from "../../agent/packed-plugin";

declare const TNB_CHANNELS_PACKAGE: PackedPlugin | undefined;
let cached: Promise<PackedPlugin> | undefined;
export function channelsRecoveryPackage(): Promise<PackedPlugin> {
  return cached ??= typeof TNB_CHANNELS_PACKAGE !== "undefined" ? Promise.resolve(TNB_CHANNELS_PACKAGE) : buildChannelsRecoveryPackage();
}
export async function buildChannelsRecoveryPackage(root = resolve(import.meta.dir, "../../..")): Promise<PackedPlugin> {
  const directory = await mkdtemp(join(tmpdir(), "tnb-channels-package-"));
  try {
    const bundle = Bun.spawn([process.execPath, "build", join(root, "src/plugins/channels/plugin-entry.ts"), "--target=bun", `--outfile=${join(directory, "index.mjs")}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [exit, output, error] = await Promise.all([bundle.exited, new Response(bundle.stdout).text(), new Response(bundle.stderr).text()]);
    if (exit !== 0) throw new Error(`Channels recovery package failed to build: ${error || output}`);
    await writeFile(join(directory, "plugin.json"), await readFile(join(root, "src/plugins/channels/plugin.json")));
    await writeFile(join(directory, "runtime.json"), JSON.stringify(channelRecoveryABI()));
    return await packPlugin(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
