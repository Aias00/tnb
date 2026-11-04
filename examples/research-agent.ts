/** Offline executable example: a scripted model, real tools, durable receipts and adapter acceptance. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentRuntime } from "../src/agent/runtime";
import type { ModelTransport } from "../src/agent";
import { createResearchAdapter, researchTask } from "../src/adapters/research";

const sources = new Map([
  ["demo/engineering", { version: "1", text: "Design A supports recovery using explicit checkpoints." }],
  ["demo/operations", { version: "1", text: "Design A requires operator reconciliation when remote outcomes are unknown." }],
]);
const transport: ModelTransport = { async *stream(request) {
  const receipts = request.messages.flatMap(message => message.role === "user" ? message.content.filter(block => block.type === "tool-result") : []);
  if (!receipts.length) {
    for (let index = 0; index < sources.size; index++) {
      yield { type: "tool-start", index, id: `source-${index}`, name: `read_source_${index}` };
      yield { type: "tool-input", index, json: "{}" };
    }
    yield { type: "response-end", reason: "tool-use" };
  } else {
    const findings = receipts.map(receipt => {
      const evidence = JSON.parse(receipt.content) as { text: string; source: string };
      return `${evidence.text} [source:${evidence.source}]`;
    });
    yield { type: "text", index: 0, text: findings.join("\n") + "\nLimitation: this is a two-document demonstration, not a general quality evaluation." };
    yield { type: "response-end", reason: "end-turn" };
  }
} };
const directory = process.argv[2] ?? await mkdtemp(join(tmpdir(), "tnb-research-demo-"));
const host = await openAgentRuntime({ directory, adapters: [createResearchAdapter({ model: "offline-scripted-demo", transport,
  readSource: async id => { const source = sources.get(id); if (!source) throw new Error("Source is not configured"); return source; },
})] });
try {
  const { run } = await host.submit({ commandId: "research-demo-v1", namespace: "demo", objective: "Compare recovery guarantees using both documents", adapter: researchTask([...sources.keys()]), mode: "single" });
  const deadline = Date.now() + 10000;
  while (!["succeeded", "failed", "paused"].includes(host.store.getRun(run.runId)!.status)) {
    if (Date.now() >= deadline) throw new Error("Demo timed out");
    await host.runtime.tick(); await Bun.sleep(10);
  }
  const state = host.store.getRun(run.runId)!, task = host.store.tasks(run.runId)[0]!;
  if (state.status !== "succeeded") throw new Error(`Demo ${state.status}: ${task.error}`);
  const result = await host.runtime.artifacts.get<{ report: string; acceptance: string; checks: unknown[] }>(task.resultRef!);
  process.stdout.write(JSON.stringify({ model: "offline scripted fixture; no external model calls", directory, runId: run.runId, taskId: task.taskId, ...result }, null, 2) + "\n");
} finally { await host.close(); }
