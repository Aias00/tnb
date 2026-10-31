import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/entrypoints/cli";
import type { ModelEvent, ModelTransport } from "../../src/providers/types";
import { SessionStore } from "../../src/services/session/storage";
import { createConfiguredTransport } from "../../src/providers/factory";
import { UsageBudget } from "../../src/services/usage/budget";
import type { ProviderModel } from "../../src/providers/config";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

test("session-end model hooks are billed before the result snapshot closes the budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-end-budget-")); roots.push(root);
  const configDir = join(root, "config"); await mkdir(configDir);
  await writeFile(join(configDir, "settings.json"), JSON.stringify({ hooks: {
    SessionEnd: [{ matcher: "prompt_input_exit", hooks: [{ type: "prompt", prompt: "Validate shutdown." }] }],
  } }));
  let requests = 0; let output = "";
  const transport: ModelTransport = { async *stream() {
    requests++;
    if (requests === 2) yield { type: "usage", usage };
    yield { type: "text", index: 0, text: requests === 2 ? '{"ok":true}' : "done" };
    yield { type: "response-end", reason: "end-turn" };
  } };
  expect(await runCli({ argv: ["-p", "fixture", "--output-format", "json"], env: {}, cwd: root, configDir, transport,
    stdout: { write(value) { output += value; } }, stderr: { write() {} },
  })).toBe(0);
  expect(requests).toBe(2);
  expect(JSON.parse(output).usage.inputTokens).toBe(1_000_000);
  expect(JSON.parse(output).total_usage.inputTokens).toBe(1_000_000);
});

test("configured physical transports attribute concurrent requests to their own model prices", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    const events = [
      { choices: [], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const model = (id: string, input: number): ProviderModel => ({ id, name: id, contextWindow: 128000, maxTokens: 1024,
    reasoning: false, supportsVision: false, supportsPdf: false, compat: {}, samplingParams: {}, pricing: { input, output: 1 } });
  const cheap = model("cheap", 0.25); const expensive = model("expensive", 2);
  // A dynamically selected model need not appear in the configured model list.
  const provider = { id: "local", name: "local", api: "openai-completions" as const, baseUrl: `${server.url}v1`, headers: {}, compat: {}, models: [cheap] };
  const raw = createConfiguredTransport({ provider, model: expensive });
  const budget = new UsageBudget();
  // Deliberately wrong outer price: physical attribution must prevail.
  const transport = budget.wrap(raw, () => ({ provider: "wrong", model: "wrong", pricing: { input: 99, output: 99 } }));
  try {
    await Promise.all([cheap, expensive].map(async (model) => {
      for await (const _ of transport.stream({ model: model.id, messages: [{ role: "user", content: [{ type: "text", text: "fixture" }] }], tools: [] })) {}
    }));
    expect(budget.totals.inputTokens).toBe(2_000_000);
    expect(budget.totals.costUsd).toBe(2.25);
  } finally { await budget.close(); server.stop(true); }
});

for (const delegated of ["agent", "skill"] as const) {
  test(`${delegated} spend is persisted and stops its parent before another model request`, async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-shared-budget-")); roots.push(root);
    const cwd = join(root, "work"); const configDir = join(root, "config");
    await mkdir(cwd); await mkdir(configDir);
    if (delegated === "skill") {
      const directory = join(configDir, "skills", "review"); await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\nReview the code.");
    }
    let requests = 0;
    const transport: ModelTransport = { async *stream(): AsyncGenerator<ModelEvent> {
      requests++;
      if (requests === 1) {
        yield { type: "tool-start", index: 0, id: "delegate", name: delegated };
        yield { type: "tool-input", index: 0, json: JSON.stringify(delegated === "agent"
          ? { description: "Review", prompt: "Review code", subagent_type: "explore" } : { name: "review" }) };
        yield { type: "response-end", reason: "tool-use" };
      } else {
        yield { type: "usage", usage };
        yield { type: "response-end", reason: "end-turn" };
      }
    } };
    let error = "";
    expect(await runCli({ argv: ["-p", "review", "--max-budget-usd", "0.01", "--yolo"],
      cwd, configDir, env: {}, sessionIdFactory: () => "budget-fixture", transport,
      stdout: { write() {} }, stderr: { write(value) { error += value; } },
    })).toBe(1);
    expect(requests).toBe(2);
    expect(error).toContain("Maximum budget");
    const state = await new SessionStore({ cwd, configDir, sessionId: "budget-fixture" }).readState();
    expect(state.usage?.inputTokens).toBe(1_000_000);
    expect(state.usage?.costUsd).toBeGreaterThan(0.01);
  });
}
