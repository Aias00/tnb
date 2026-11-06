import { defineAgent, definePlugin, defineTool, type JsonValue } from "@tnb/plugin-sdk";

function ticket(config: JsonValue): string {
  if (!config || typeof config !== "object" || Array.isArray(config) || typeof config.ticket !== "string") throw new Error("Ticket required");
  return config.ticket;
}
export default definePlugin(api => api.registerAdapter(defineAgent({
  id: "ticket-review", version: "1",
  configuration: { type: "object", properties: { ticket: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["ticket"], additionalProperties: false },
  async snapshot(context) { return { ticket: ticket(context.descriptor.config) }; },
  async createWorker(context) {
    const text = ticket(context.descriptor.config);
    return {
      model: "offline-ticket-review", route: { provider: "fixture", model: "offline-ticket-review" }, maxOutputTokens: 512,
      tools: [defineTool({ name: "read_ticket", description: "Read this authorized ticket", access: "read",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        capability: { name: "ticket.read", mode: "read", resources: context.descriptor.resources.map(row => row.id) },
        effects: { replay: "safe" }, validate(value) { if (!value || typeof value !== "object" || Object.keys(value).length) throw new Error("No arguments expected"); return {}; },
        async execute() { context.signal.throwIfAborted(); return text; } })],
      authorize: async () => ({ behavior: "allow" }),
      // Offline fixture verifies the host contract, not production model quality.
      transport: { async *stream(request) {
        const read = request.messages.some(message => message.content.some(block => block.type === "tool-result" && block.toolUseId === "ticket"));
        if (!read) {
          yield { type: "tool-start", index: 0, id: "ticket", name: "read_ticket" };
          yield { type: "tool-input", index: 0, json: "{}" }; yield { type: "response-end", reason: "tool-use" };
        } else { yield { type: "text", index: 0, text: "Reviewed ticket: " + text }; yield { type: "response-end", reason: "end-turn" }; }
      } },
    };
  },
  async accept(context, candidate) {
    const expected = ticket(context.descriptor.config);
    if (!candidate.report.includes(expected) || !candidate.receipts.some(row => row.name === "read_ticket" && row.result === expected && !row.truncated)) throw new Error("Missing ticket evidence");
    return { checks: [{ command: "ticket-receipt", output: "Confirmed authorized ticket read" }] };
  },
})));
