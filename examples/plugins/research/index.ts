/** Bundle this entry and its dependencies into index.mjs before installation. */
import type { AdapterPluginFactory } from "../../../src/agent/runtime";
import type { ModelTransport } from "../../../src/agent";
import { createResearchAdapter } from "../../../src/adapters/research";

const source = { version: "1", text: "Recovery must bind the exact adapter package and verify actual tool receipts." };
const transport: ModelTransport = { async *stream(request) {
  const read = request.messages.some(message => message.role === "user" && message.content.some(block => block.type === "tool-result"));
  if (!read) {
    yield { type: "tool-start", index: 0, id: "source", name: "read_source_0" };
    yield { type: "tool-input", index: 0, json: "{}" };
    yield { type: "response-end", reason: "tool-use" };
  } else {
    yield { type: "text", index: 0, text: source.text + " [source:demo/plugin]" };
    yield { type: "response-end", reason: "end-turn" };
  }
} };
const setup: AdapterPluginFactory = api => {
  api.registerAdapter(createResearchAdapter({ model: "offline-scripted-plugin", transport,
    async readSource(id) { if (id !== "demo/plugin") throw new Error("Unknown source"); return source; },
  }));
};
export default setup;
