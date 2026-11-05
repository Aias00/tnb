import packageJson from "../../../package.json";
import { createCodingAdapter } from "./adapter";
import { codingPluginFingerprint } from "./identity";
import type { BuiltinAdapterPlugin } from "../../agent/plugins";
import type { CodingWorkerFactory } from "./capabilities";
import { codingRecoveryPackage } from "./recovery-package";
import setup from "./plugin-entry";

export type CodingPluginOptions = { configDir: string; runtimeRoot: string; env: Record<string, string | undefined>; workerFactory?: CodingWorkerFactory };
/** The shipped profile uses exactly the same registration transaction and lifecycle as installed domains. */
export async function createCodingPlugin(options: CodingPluginOptions): Promise<BuiltinAdapterPlugin> {
  if (!options.workerFactory) {
    const packed = await codingRecoveryPackage();
    return { identity: { name: "tnb-coding", version: packageJson.version, fingerprint: packed.fingerprint },
      adapters: [{ id: "coding", version: "1" }], package: packed, setup,
      configuration: { configDir: options.configDir, env: { ...options.env } } };
  }
  return { identity: { name: "tnb-coding", version: packageJson.version, fingerprint: await codingPluginFingerprint() }, adapters: [{ id: "coding", version: "1" }],
    setup: api => { api.registerAdapter(createCodingAdapter(options.workerFactory!)); } };
}
export default setup;
