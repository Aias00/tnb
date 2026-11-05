import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHostPlugins, type HostPluginAPI } from "../src/agent/plugins";
import { createServiceRef, provideService } from "../src/agent/services";
import { RuntimeStore } from "../src/services/runtime/store";

type Greeting = { greet(name: string): string };
const GREETING = createServiceRef<Greeting>({ id: "example.greeting", version: 1, scope: "contribution", methods: { greet: true } });
const root = await mkdtemp(join(tmpdir(), "tnb-typed-service-")), store = new RuntimeStore(":memory:");
const plugins = await loadHostPlugins({ roots: [], trustStorePath: join(root, "trust.json"), builtins: [{
  identity: { name: "greeting-example", version: "1.0.0", fingerprint: createHash("sha256").update("greeting-example/v1").digest("hex") },
  extensions: [{ kind: "application", id: "greeting", version: "1", entry: "index.mjs", services: [GREETING.name], requires: [] }],
  setup(api: HostPluginAPI) { api.registerApplication({ id: "greeting", version: "1", start(context) {
    const service = context.service(GREETING); // Type inferred; no service<T>(string) assertion.
    return { handle: () => Response.json({ message: service.greet("TNB") }) };
  } }); },
}] });
try {
  await plugins.extensions.start({ store, serviceProviders: [provideService(GREETING, scope => ({ greet(name) {
    if (typeof name !== "string" || !name.trim() || name.length > 128) throw new Error("Invalid greeting name");
    return `${scope.consumer!.plugin.name}: Hello ${name}`;
  } }))], grants: { "greeting-example": [GREETING.name] } });
  const response = await plugins.extensions.handle({ kind: "application", id: "greeting", version: "1" }, new Request("http://plugin/greeting"));
  process.stdout.write(`${JSON.stringify(await response.json())}\n`);
} finally {
  await plugins.close(); store.close(); await rm(root, { recursive: true, force: true });
}
