import { join } from "node:path";
import { homedir } from "node:os";
import { createCodingAdapter } from "./adapter";
import { createRuntimeWorkerFactory } from "./worker";
import type { AdapterPluginFactory } from "../../agent/plugins";

/** Self-contained installed/embedded entry; never imports its own package builder. */
const setup: AdapterPluginFactory = api => {
  if (!api.stateDirectory) throw new Error("Coding plugin requires its host state directory");
  const config = api.configuration as { configDir?: unknown; env?: unknown } | undefined;
  if (config?.configDir !== undefined && typeof config.configDir !== "string") throw new Error("Invalid coding host settings directory");
  const environment = config?.env ?? process.env;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)
    || Object.values(environment).some(value => value !== undefined && typeof value !== "string")) throw new Error("Invalid coding host environment");
  api.registerAdapter(createCodingAdapter(createRuntimeWorkerFactory({ configDir: config?.configDir as string | undefined ?? join(homedir(), ".tnb"),
    runtimeRoot: api.stateDirectory, env: { ...environment as Record<string, string | undefined> }, bundledSkillIdentity: api.identity.fingerprint })));
};
export default setup;
