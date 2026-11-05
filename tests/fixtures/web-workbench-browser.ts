import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DurableRuntime } from "../../src/services/runtime/engine";
import { RuntimeStore } from "../../src/services/runtime/store";
import { serveDurableRuntime } from "../../src/services/runtime/server";
import { runWebCommand } from "../../src/entrypoints/web";
const root = process.argv[2]!, workspace = join(root, "work"), configDir = join(root, "config");
await mkdir(workspace, { recursive: true }); await mkdir(configDir, { recursive: true });
await writeFile(join(configDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "browser-fixture-private-key", name: "本地验证", models: [{ id: "fixture", name: "脚本模型" }] } } }));
const store = new RuntimeStore(join(configDir, "runtime/state.sqlite")), counts = new Map<string, number>();
const runtime = new DurableRuntime(store, join(configDir, "runtime"), async ({ task }) => ({ model: "fixture", tools: [], maxOutputTokens: 4096,
  route: { provider: "fixture", model: "fixture", pricing: { input: 1, output: 1 } }, authorize: async () => ({ behavior: "allow" }), transport: { async *stream() {
    const count = (counts.get(task.taskId) ?? 0) + 1; counts.set(task.taskId, count);
    if (count === 1) {
      yield { type: "tool-start", index: 0, id: "choose", name: "durable_wait" };
      yield { type: "tool-input", index: 0, json: JSON.stringify({ kind: "question", key: "database", question: "选择数据库", options: ["SQLite", "其他"], about: "已检查代码中的状态流转。选择后继续输出方案。" }) };
      yield { type: "response-end", reason: "tool-use" };
    } else { yield { type: "text", index: 0, text: "SQLite 方案已确认。\n执行和恢复共用同一份持久状态。\n<script>globalThis.pwned=true</script>" }; yield { type: "response-end", reason: "end-turn" }; }
  } },
}));
const controller = new AbortController(), ready = Promise.withResolvers<void>();
process.once("SIGTERM", () => controller.abort()); process.once("SIGINT", () => controller.abort());
const done = serveDurableRuntime({ configDir, env: {}, runtime, signal: controller.signal, ready: () => ready.resolve() });
await ready.promise;
await runWebCommand({ argv: ["web", "--json", "--no-start", "--config-dir", configDir, "--cwd", workspace], cwd: workspace, env: {}, stdout: process.stdout, stderr: process.stderr });
try { await done; } finally { store.close(); }
