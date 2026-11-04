import { appendFile, readFile } from "node:fs/promises";
const settings = JSON.parse(await readFile(new URL("settings.json", import.meta.url), "utf8"));
const log = event => appendFile(settings.trace, `${event}\n`);
await log("import");
function* call(name, input) {
  yield { type: "tool-start", index: 0, id: name, name };
  yield { type: "tool-input", index: 0, json: JSON.stringify(input) };
  yield { type: "response-end", reason: "tool-use" };
}
export default async function setup(api) {
  api.onDispose(() => log("dispose-first"));
  api.onDispose(async () => { await log("dispose-last"); if (settings.failDispose) throw new Error("dispose error"); });
  api.registerAdapter({
    id: settings.id ?? "fixture", version: "1",
    validate(config) { if (!config || typeof config !== "object") throw new Error("Expected object configuration"); },
    async snapshot() { return { revision: 1 }; },
    async createWorker(context) {
      return { model: "offline-plugin", route: { provider: "fixture", model: "offline-plugin" }, maxOutputTokens: 512,
        authorize: async () => ({ behavior: "allow" }), tools: [{
          name: "lookup", description: "Read a fixture fact", inputSchema: { type: "object" }, access: "read",
          capability: { name: "read", resources: context.descriptor.resources.map(item => item.id), mode: "read" },
          effects: { replay: "safe" }, validate: input => input, isReadOnly: () => true, isConcurrencySafe: () => true,
          async execute() { await log("tool"); return "actual plugin fact"; },
        }], transport: { async *stream(request) {
          await log("model");
          const receipts = request.messages.flatMap(message => message.role === "user" ? message.content.filter(block => block.type === "tool-result") : []);
          if (context.descriptor.config.hold) {
            await new Promise(resolve => context.signal.addEventListener("abort", resolve, { once: true }));
            await log("worker-aborted"); context.signal.throwIfAborted();
          }
          if (!receipts.some(item => item.toolUseId === "lookup")) { yield* call("lookup", {}); return; }
          if (context.descriptor.config.wait && !receipts.some(item => item.toolUseId === "durable_wait")) {
            yield* call("durable_wait", { kind: "question", key: "choice", question: "Continue?", options: ["A", "B"], about: "Evidence read, waiting for approval" }); return;
          }
          yield { type: "text", index: 0, text: "Verified actual plugin fact" };
          yield { type: "response-end", reason: "end-turn" };
        } }, async close() { await log("worker-close"); },
      };
    },
    async accept(_context, candidate) {
      if (!candidate.receipts.some(receipt => receipt.name === "lookup" && receipt.result === "actual plugin fact")) throw new Error("Missing actual tool receipt");
      return { checks: [{ command: "lookup-receipt", output: "Actual fact confirmed" }] };
    },
  });
  if (settings.fail) throw new Error("Factory failed after registration");
}
