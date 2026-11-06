export const PLUGIN_TEMPLATES = ["agent", "application", "channel"] as const;
export type PluginTemplate = typeof PLUGIN_TEMPLATES[number];

/** Standalone ESM packages: no TNB checkout paths, build step or downloaded dependencies. */
export function pluginTemplate(name: string, template: PluginTemplate): Record<string, string> {
  const manifest = { name, version: "0.1.0", manifestVersion: 2, apiVersion: "tnb.host-plugin/v1", description: `${name} ${template} plugin`, contributes: {} as Record<string, unknown> };
  let code: string, scenarios: unknown[];
  if (template === "agent") {
    manifest.contributes.adapters = [{ id: name, version: "1", entry: "index.mjs" }];
    code = `// Offline transport proves tool execution and domain acceptance without an API key.
// Replace createWorker's transport with your model integration for real work.
export default api => api.registerAdapter({
  id: ${JSON.stringify(name)}, version: "1",
  validate(config) {
    if (!config || typeof config.message !== "string" || !config.message.trim()) throw new Error("config.message is required");
  },
  async snapshot(context) { return { message: context.descriptor.config.message }; },
  async createWorker(context) {
    const message = context.descriptor.config.message;
    return {
      model: "offline-demo", route: { provider: "local-fixture", model: "offline-demo" }, maxOutputTokens: 256,
      authorize: async () => ({ behavior: "allow" }),
      tools: [{
        name: "read_message", description: "Read the message authorized by this task",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }, access: "read",
        capability: { name: "read", resources: context.descriptor.resources.map(item => item.id), mode: "read" },
        effects: { replay: "safe" }, validate: value => value,
        isReadOnly: () => true, isConcurrencySafe: () => true,
        async execute() { context.signal.throwIfAborted(); return message; },
      }],
      transport: { async *stream(request) {
        const read = request.messages.some(row => row.role === "user" && row.content.some(block => block.type === "tool-result" && block.toolUseId === "message"));
        if (!read) {
          yield { type: "tool-start", index: 0, id: "message", name: "read_message" };
          yield { type: "tool-input", index: 0, json: "{}" };
          yield { type: "response-end", reason: "tool-use" };
        } else {
          yield { type: "text", index: 0, text: "Verified: " + message };
          yield { type: "response-end", reason: "end-turn" };
        }
      } },
    };
  },
  async accept(context, candidate) {
    if (!candidate.receipts.some(row => row.name === "read_message" && row.result === context.descriptor.config.message)
      || !candidate.report.includes(context.descriptor.config.message)) throw new Error("Missing actual message evidence");
    return { checks: [{ command: "message-receipt", output: "Authorized message confirmed" }] };
  },
});
`;
    scenarios = [{ kind: "task", objective: "Read the authorized message and report it", adapter: { id: name, version: "1", config: { message: "Hello from my plugin" }, resources: [{ id: `${name}/message`, mode: "read" }], grants: [{ name: "read", resources: [`${name}/message`], mode: "read" }] }, expect: { reportIncludes: "Hello from my plugin", tools: ["read_message"] } }];
  } else if (template === "application") {
    manifest.contributes.applications = [{ id: name, version: "1", entry: "index.mjs" }];
    manifest.contributes.interfaces = [{ id: `${name}-view`, version: "1", entry: "index.mjs", requires: [{ kind: "application", id: name, version: "1" }] }];
    code = `export default api => {
  api.registerApplication({ id: ${JSON.stringify(name)}, version: "1", start(context) {
    context.state.command("initialize", { schema: 1 }, tx => tx.save("visits", 0, 0));
    return { async handle(request) {
      if (request.method === "POST") {
        const { commandId } = await request.json();
        if (typeof commandId !== "string" || !commandId) return Response.json({ error: "commandId required" }, { status: 400 });
        context.state.command(commandId, { action: "visit" }, tx => {
          const row = tx.get("visits"); return tx.save("visits", row.value + 1, row.revision);
        });
      }
      return Response.json({ ready: true, visits: context.state.get("visits").value });
    } };
  } });
  api.registerInterface({ id: ${JSON.stringify(name + "-view")}, version: "1", start(context) {
    return { async handle() {
      const response = await context.request({ kind: "application", id: ${JSON.stringify(name)}, version: "1" }, new Request("http://plugin/status"));
      const value = await response.json();
      return new Response("<!doctype html><title>My plugin</title><h1>Visits=" + Number(value.visits) + "</h1>", { headers: { "content-type": "text/html; charset=utf-8" } });
    } };
  } });
};
`;
    const request = (method: string, visits: number) => ({ kind: "request", contribution: { kind: "application", id: name, version: "1" }, method, path: "/status", ...(method === "POST" ? { body: { commandId: "visit-1" } } : {}), expect: { status: 200, json: { ready: true, visits } } });
    scenarios = [request("GET", 0), request("POST", 1), request("POST", 1), { kind: "request", contribution: { kind: "interface", id: `${name}-view`, version: "1" }, method: "GET", path: "/", expect: { status: 200, textIncludes: "Visits=1" } }];
  } else {
    manifest.contributes.channels = [{ id: name, version: "1", entry: "index.mjs" }];
    code = `// Local example: poll one event and keep idempotent notification receipts.
export default api => api.registerChannel({ id: ${JSON.stringify(name)}, version: "1", connect(configuration, context) {
  if (typeof configuration.text !== "string") throw new Error("configuration.text is required");
  return {
    async poll(cursor, signal) {
      signal.throwIfAborted();
      return { cursor: "initial", events: cursor === "initial" ? [] : [{ externalId: "initial", actor: "operator", thread: "demo", text: configuration.text }] };
    },
    async send(message, signal) {
      signal.throwIfAborted();
      return context.state.command(message.id, { thread: message.thread, text: message.text }, tx => {
        const receipt = "local:" + message.id; tx.save(message.id, { receipt }, 0); return receipt;
      });
    },
    async find(message, signal) { signal.throwIfAborted(); return context.state.get(message.id)?.value.receipt; },
  };
} });
`;
    scenarios = [{ kind: "channel", channel: { id: name, version: "1" }, configuration: { text: "Hello from my channel" }, message: { id: "notice-1", thread: "demo", text: "Ready" }, expect: { receipt: "local:notice-1", events: 1 } }];
  }
  return {
    "plugin.json": JSON.stringify(manifest, null, 2) + "\n", "index.mjs": code,
    "plugin.test.json": JSON.stringify({ version: 1, scenarios }, null, 2) + "\n",
    "README.md": `# ${name}\n\nGenerated TNB ${template} plugin. Requires TNB and Bun-compatible ESM; no dependency install or build is needed.\n\n\`\`\`sh\ntnb plugins validate .\ntnb plugins test . --yes\n\`\`\`\n\nEdit index.mjs and plugin.test.json together, then repeat validation and tests. Agent transport is an offline fixture, not a production model. The test command executes trusted plugin code in your process with temporary host state; it is not a sandbox. It does not install into your real TNB configuration.\n\nAfter reviewing the package:\n\n\`\`\`sh\ntnb plugins install .\ntnb plugins trust ${name} --yes\ntnb plugins enable ${name}\ntnb runtime restart\ntnb runtime plugins\n\`\`\`\n\nApplication/interface contributions need a host request route; channels need an explicit Source configuration. An adapter template runs through the SDK and test harness; installation alone does not add a new default CLI task route. Add host services and business model credentials explicitly when integrating real work.\n`,
  };
}
