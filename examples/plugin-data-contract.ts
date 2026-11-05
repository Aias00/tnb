import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExtensionHost } from "../src/agent/extension-host";
import { contributionConfigurationKey } from "../src/agent/plugin-data";
import type { ExtensionContext, ExtensionRegistration } from "../src/agent/extensions";
import { RuntimeStore } from "../src/services/runtime/store";

const root = await mkdtemp(join(tmpdir(), "tnb-data-contract-example-")), store = new RuntimeStore(":memory:");
const plugin = { name: "data-example", version: "1.0.0", fingerprint: "a".repeat(64) }, ref = { kind: "application" as const, id: "counter", version: "1" };
const declaration = { ...ref, entry: "index.mjs", services: [], requires: [] };
let state!: ExtensionContext["state"];
const legacy: ExtensionRegistration = { plugin, declaration, definition: { id: ref.id, version: ref.version, start(context) {
  state = context.state; return {};
} } };
const before = new ExtensionHost([legacy], [], root);
const upgraded: ExtensionRegistration = { plugin: { ...plugin, fingerprint: "b".repeat(64) }, declaration: { ...declaration,
  configuration: { version: 1, schema: { type: "object", properties: { label: { type: "string", maxLength: 64 } }, required: ["label"], additionalProperties: false } },
  state: { version: 1, migrations: [{ from: 0, to: 1 }] },
}, definition: { id: ref.id, version: ref.version, migrations: [{ from: 0, to: 1, migrate(tx) {
  const row = tx.get<{ count: number }>("counter")!; tx.save("counter", { total: row.value.count }, row.revision);
} }], start(context) { return { handle: () => Response.json({ configuration: context.configuration, state: context.state.get("counter")?.value }) }; } } };
const after = new ExtensionHost([upgraded], [], root);
try {
  await before.start({ store }); state.command("legacy-data", {}, tx => tx.save("counter", { count: 7 }, 0)); await before.stop();
  await after.start({ store, configuration: { [plugin.name]: { [contributionConfigurationKey(ref)]: { version: 1, value: { label: "migrated example" } } } } });
  const response = await after.handle(ref, new Request("http://plugin/counter"));
  process.stdout.write(`${JSON.stringify(await response.json())}\n${JSON.stringify(after.list())}\n`);
} finally { await before.stop(); await after.stop(); store.close(); await rm(root, { recursive: true, force: true }); }
