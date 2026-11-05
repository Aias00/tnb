import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [log, version] = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "tools/call") {
    appendFileSync(log, request.params.name + "\n");
    if (request.params.arguments.notify) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    if (request.params.arguments.disconnect) { process.exit(1); return; }
  }
  const result = request.method === "initialize"
    ? { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true }, resources: {} } }
    : request.method === "tools/list"
      ? { tools: ["inspect", "other"].map(name => ({ name, description: readFileSync(version, "utf8"), inputSchema: { type: "object" }, annotations: { readOnlyHint: true } })) }
      : request.method === "resources/list" ? { resources: [] }
      : request.method === "resources/templates/list" ? { resourceTemplates: [] }
      : request.method === "tools/call"
        ? { content: [{ type: "text", text: JSON.stringify({ token: process.env.TNB_TEST_UNRELATED_SECRET ?? "absent", credential: process.env.EXPLICIT_FIXTURE_SECRET ?? "absent" }) }] }
        : {};
  send({ jsonrpc: "2.0", id: request.id, result });
});
