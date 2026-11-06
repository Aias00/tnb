import { createServiceRef, defineProcessPlugin, PROCESS_PLUGIN_PROTOCOL, type JsonValue } from "@tnb/plugin-sdk";

const support = createServiceRef<{ classify(queue: string, text: string): Promise<JsonValue> }>({ id: "example.support", version: 1, scope: "contribution", methods: { classify: true } });
export default defineProcessPlugin({ protocol: PROCESS_PLUGIN_PROTOCOL, async start(context) {
  const config = context.configuration;
  if (!config || typeof config !== "object" || Array.isArray(config) || typeof config.queue !== "string") throw new Error("Queue required");
  const queue = config.queue;
  return { async handle(request) {
    if (request.method !== "POST") return { status: 405, body: "POST required" };
    const input = JSON.parse(request.body ?? "{}");
    if (typeof input.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(input.id) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 4096) return { status: 400, body: "Invalid ticket" };
    const previous = await context.state.get<{ text: string; classification: JsonValue }>(input.id);
    if (previous && previous.value.text !== input.text) return { status: 409, body: "Ticket ID already used with different text" };
    const classification = previous ? previous.value.classification : await context.call(support, "classify", [queue, input.text]);
    if (!previous) await context.state.command(input.id, { text: input.text }, [{ id: input.id, previousRevision: 0, value: { text: input.text, classification } }]);
    return { status: 200, headers: [["content-type", "application/json"]], body: JSON.stringify({ id: input.id, queue, classification }) };
  } };
} });
