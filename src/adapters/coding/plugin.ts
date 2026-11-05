import { join } from "node:path";
import { homedir } from "node:os";
import packageJson from "../../../package.json";
import { createCodingAdapter } from "./adapter";
import { createRuntimeWorkerFactory } from "./worker";
import { codingPluginFingerprint } from "./identity";
import type { AdapterPluginFactory, BuiltinAdapterPlugin } from "../../agent/plugins";
import type { CodingWorkerFactory } from "./capabilities";

export type CodingPluginOptions = { configDir: string; runtimeRoot: string; env: Record<string, string | undefined>; workerFactory?: CodingWorkerFactory };
/** The shipped profile uses exactly the same registration transaction and lifecycle as installed domains. */
export async function createCodingPlugin(options: CodingPluginOptions): Promise<BuiltinAdapterPlugin> {
  return { identity: { name: "tnb-coding", version: packageJson.version, fingerprint: await codingPluginFingerprint() }, adapters: [{ id: "coding", version: "1" }],
    setup: api => { api.registerAdapter(createCodingAdapter(options.workerFactory ?? createRuntimeWorkerFactory(options))); } };
}
/** Entry for a separately bundled/installed coding package. Settings are supplied by its trusted host. */
const setup: AdapterPluginFactory = api => {
  if (!api.stateDirectory) throw new Error("Coding plugin requires its host state directory");
  const config = api.configuration as { configDir?: unknown; env?: unknown } | undefined;
  if (config?.configDir !== undefined && typeof config.configDir !== "string") throw new Error("Invalid coding host settings directory");
  const environment = config?.env ?? process.env;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)
    || Object.values(environment).some(value => value !== undefined && typeof value !== "string")) throw new Error("Invalid coding host environment");
  api.registerAdapter(createCodingAdapter(createRuntimeWorkerFactory({ configDir: config?.configDir as string | undefined ?? join(homedir(), ".tnb"),
    runtimeRoot: api.stateDirectory, env: { ...environment as Record<string, string | undefined> } })));
};
export default setup;
