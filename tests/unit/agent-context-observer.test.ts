import { expect, test } from "bun:test";
import { runAgentLoop } from "../../src/core/agent-loop";
import type { ModelRequest, ModelTransport } from "../../src/providers/types";
test("request observations belong to the current loop and cannot mutate or fail the actual request", async () => {
  const observed: ModelRequest[] = [], sent: ModelRequest[] = [];
  const transport: ModelTransport = { async *stream(request) { sent.push(structuredClone(request)); yield { type:"text",index:0,text:"done" }; yield { type:"response-end",reason:"end-turn" }; } };
  for await (const _ of transport.stream({ model:"fixture",messages:[{role:"user",content:[{type:"text",text:"maintenance"}]}],tools:[] })) {}
  await runAgentLoop({ model:"fixture", prompt:"main prompt", systemPrompt:"instructions", tools:[], transport, authorize:async()=>({behavior:"allow"}), onModelRequest(request) {
    observed.push(structuredClone(request)); request.messages.length=0; throw new Error("observer failed");
  } });
  expect(observed).toHaveLength(1); expect(JSON.stringify(observed[0])).toContain("main prompt"); expect(JSON.stringify(observed[0])).not.toContain("maintenance");
  expect(sent).toHaveLength(2); expect(JSON.stringify(sent[1])).toContain("main prompt");
});
