import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { query } from "../../src/sdk/query";
import { SessionStore } from "../../src/services/session/storage";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("SDK abort terminates a single-turn child without requiring bidirectional control", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-sdk-abort-")); roots.push(root);
  const fixture = join(root, "child.ts"), pidFile = join(root, "pid");
  await writeFile(fixture, `await Bun.write(${JSON.stringify(pidFile)},String(process.pid)); console.log(JSON.stringify({type:"system",subtype:"init"})); setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const q = query({ prompt: "wait", options: { pathToTnbExecutable: process.execPath, executableArgs: [fixture], signal: controller.signal } });
  try {
    expect((await q.next()).value?.type).toBe("system");
    controller.abort(new DOMException("Test cancellation", "AbortError"));
    await expect(q.next()).rejects.toThrow("Test cancellation");
    const pid = Number(await readFile(pidFile, "utf8"));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) { try { process.kill(pid, 0); } catch { return; } await Bun.sleep(10); }
    throw new Error("Aborted SDK child remained alive");
  } finally { q.close(); }
});

test("SDK removes abort listeners after a query has completed", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-sdk-finished-")); roots.push(root);
  const fixture = join(root, "child.ts");
  await writeFile(fixture, 'console.log(JSON.stringify({type:"result",subtype:"success",result:"done"}));');
  const controller = new AbortController(); let attached = 0;
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args: Parameters<AbortSignal["addEventListener"]>) => { if (args[0] === "abort") attached++; return add(...args); };
  controller.signal.removeEventListener = (...args: Parameters<AbortSignal["removeEventListener"]>) => { if (args[0] === "abort") attached--; return remove(...args); };
  const q = query({ prompt: "finish", options: { pathToTnbExecutable: process.execPath, executableArgs: [fixture], signal: controller.signal } });
  const records = []; for await (const message of q) records.push(message);
  expect(records.at(-1)?.type).toBe("result"); expect(attached).toBe(0);
  expect(() => controller.abort()).not.toThrow(); q.close();
});

test("SDK ignores an approval callback that resolves after cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-sdk-late-approval-")); roots.push(root);
  const fixture = join(root, "child.ts");
  await writeFile(fixture, 'console.log(JSON.stringify({type:"control_request",request_id:"late",request:{subtype:"can_use_tool",tool_name:"write",input:{path:"proof"}}}));setInterval(()=>{},1000);');
  const started = Promise.withResolvers<void>(), decision = Promise.withResolvers<void>();
  const controller = new AbortController();
  const q = query({ prompt: "write", options: { pathToTnbExecutable: process.execPath, executableArgs: [fixture], signal: controller.signal,
    canUseTool: async () => { started.resolve(); await decision.promise; return { behavior: "allow" }; } } });
  try {
    await started.promise; controller.abort(new DOMException("Cancel approval", "AbortError"));
    await expect(q.next()).rejects.toThrow("Cancel approval");
    decision.resolve(); await Bun.sleep(30);
  } finally { decision.resolve(); q.close(); }
});

test("finite multi-turn SDK input stays open for approvals through the last result", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-sdk-approval-")); roots.push(root);
  const fixture = join(root, "child.ts");
  await writeFile(fixture, `import {createInterface} from "node:readline";
    const rl=createInterface({input:process.stdin});let turns=0,done=0;
    for await(const line of rl){const m=JSON.parse(line);
      if(m.type==="user"){turns++;console.log(JSON.stringify({type:"control_request",request_id:String(turns),request:{subtype:"can_use_tool",tool_name:"write",input:{path:"proof-"+turns}}}));}
      if(m.type==="control_response"){done++;console.log(JSON.stringify({type:"result",subtype:"success",result:m.response.behavior+"-"+m.request_id}));}
    }
    if(done!==2)process.exitCode=1;`);
  async function* prompts() {
    yield { type: "user" as const, message: { role: "user" as const, content: "one" } };
    yield { type: "user" as const, message: { role: "user" as const, content: "two" } };
  }
  const approvals: string[] = [];
  const q = query({ prompt: prompts(), options: { pathToTnbExecutable: process.execPath, executableArgs: [fixture],
    canUseTool: async (_tool, input) => { await Bun.sleep(10); approvals.push((input as { path: string }).path); return { behavior: "allow" }; } } });
  try {
    const results = []; for await (const message of q) if (message.type === "result") results.push(message.result);
    expect(results).toEqual(["allow-1", "allow-2"]); expect(approvals).toEqual(["proof-1", "proof-2"]);
  } finally { q.close(); }
});

test("piped SDK input survives asynchronous session fork startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-sdk-fork-")); roots.push(root);
  const cwd = join(root, "workspace"), configDir = join(root, "config"); await mkdir(cwd); await mkdir(configDir);
  await new SessionStore({ cwd, configDir, sessionId: "source" }).append([
    { role: "user", content: [{ type: "text", text: "remember FORK_CONTEXT" }] },
    { role: "assistant", content: [{ type: "text", text: "remembered" }] },
  ]);
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { messages: unknown[] }; calls++;
    expect(JSON.stringify(body.messages)).toContain("FORK_CONTEXT");
    return new Response('data: {"choices":[{"delta":{"content":"fork continued"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  await writeFile(join(configDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: String(server.url) + "v1", apiKey: "fixture", models: [{ id: "fixture", contextWindow: 32000, maxTokens: 256 }] } } }));
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error("Fork startup timed out")), 5000);
  const q = query({ prompt: "continue fork", options: { cwd, env: { TNB_HOME: configDir }, provider: "fixture", model: "fixture", tools: [],
    resume: "source", forkSession: true, sessionId: "target", pathToTnbExecutable: process.execPath,
    executableArgs: [resolve(import.meta.dir, "../../src/entrypoints/cli.ts")], signal: controller.signal } });
  try {
    const records = []; for await (const message of q) records.push(message);
    expect(records.at(-1)).toMatchObject({ type: "result", subtype: "success", session_id: "target", result: "fork continued" });
    expect(calls).toBe(1);
    expect((await new SessionStore({ cwd, configDir, sessionId: "source" }).readState()).messages).toHaveLength(2);
  } finally { clearTimeout(timer); q.close(); await server.stop(true); }
}, 10000);
