import { pluginTemplate, type PluginTemplate } from "./templates";

export function processPluginTemplate(name: string, template: PluginTemplate): Record<string, string> {
  if (template === "agent") throw new Error("Process execution supports application and channel templates; Agent workers remain host-managed");
  const files = pluginTemplate(name, template), manifest = JSON.parse(files["plugin.json"]!);
  // Each process entry owns one contribution; no host-imported registration factory.
  if (template === "application") delete manifest.contributes.interfaces;
  const row = manifest.contributes[template === "application" ? "applications" : "channels"][0];
  row.execution = { mode: "process", protocol: "tnb.process-plugin/v1", timeoutMs: 30000 }; row.state = { version: 1 };
  const code = template === "application" ? `export default { protocol: "tnb.process-plugin/v1", async start(context) {
  return { async handle(request) {
    if (request.method === "POST") {
      const { commandId } = JSON.parse(request.body || "{}");
      if (typeof commandId !== "string" || !commandId) return { status: 400, body: "commandId required" };
      // A fixed command input and write value make retry after a lost reply idempotent.
      await context.state.command(commandId, { action: "visit" }, [{ id: commandId, value: { visited: true }, previousRevision: 0 }]);
    }
    let visits = 0, after = "";
    for (;;) { const rows = await context.state.list(after, 256); visits += rows.length; if (rows.length < 256) break; after = rows.at(-1)?.id ?? ""; }
    return { status: 200, headers: [["content-type", "application/json"]], body: JSON.stringify({ ready: true, visits }) };
  } };
} };
` : `export default { protocol: "tnb.process-plugin/v1", async start(context) {
  const configuration = context.configuration;
  if (!configuration || typeof configuration.text !== "string") throw new Error("configuration.text is required");
  return {
    async poll(cursor) { return { cursor: "initial", events: cursor === "initial" ? [] : [{ externalId: "initial", actor: "operator", thread: "demo", text: configuration.text }] }; },
    async send(message) {
      const receipt = "local:" + message.id;
      await context.state.command(message.id, { thread: message.thread, text: message.text }, [{ id: message.id, value: { receipt }, previousRevision: 0 }]);
      return receipt;
    },
    async find(message) { return (await context.state.get(message.id))?.value.receipt; },
  };
} };
`;
  const tests = JSON.parse(files["plugin.test.json"]!);
  if (template === "application") tests.scenarios = tests.scenarios.filter((row: any) => row.contribution.kind === "application");
  return { ...files, "plugin.json": JSON.stringify(manifest, null, 2) + "\n", "index.mjs": code,
    "plugin.test.json": JSON.stringify(tests, null, 2) + "\n",
    "README.md": files["README.md"]! + "\nThis entry runs in a dedicated process. State and service calls are async JSON RPC; do not use the in-process registration API. Host calls are bounded and a failed process is not automatically restarted or replayed. This is fault isolation, not an OS security sandbox. See docs/guides/process-plugins.md.\n" };
}
