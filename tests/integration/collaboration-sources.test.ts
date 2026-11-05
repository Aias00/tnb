import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCollaborationConfig, loadCollaborationConfig, sourceIdentity } from "../../src/services/collaboration/config";
import { authenticate, GitHubSource, notificationBody, signature, TimerSource, WebhookSource } from "../../src/services/collaboration/sources";
import { CollaborationHost } from "../../src/services/collaboration/host";
import { NS } from "../../src/services/collaboration/engine";
import type { Notification, Source, Ticket } from "../../src/services/collaboration/types";
import { DurableRuntime } from "../../src/services/runtime/engine";
import { RuntimeStore } from "../../src/services/runtime/store";
import { runtimeRequest, serveDurableRuntime } from "../../src/services/runtime/server";
import { runCollaborationCommand } from "../../src/entrypoints/collaboration";

const secret = "fixture-secret-at-least-sixteen", env = { BRIDGE_KEY: secret, GH_TOKEN: secret };
const servers: ReturnType<typeof Bun.serve>[] = [], roots: string[] = [], stores: RuntimeStore[] = [], cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); for (const server of servers.splice(0)) await server.stop(true); stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-collab-sources-")); roots.push(root); await mkdir(join(root, "work")); const workspace = await realpath(join(root, "work"));
  const raw = { enabled: true, listen: { hostname: "127.0.0.1", port: 19998 }, sources: [{ id: "bridge", type: "webhook", actors: ["alice"], controllers: ["alice"], configuration: { workspace, allowWrite: false, allowShell: false, checks: [] }, mode: "single", webhook: { secretEnv: "BRIDGE_KEY", outboundUrl: "http://127.0.0.1:19999/notify" } }] };
  return { root, workspace, raw, config: await parseCollaborationConfig(raw) };
}
function listen(fetch: (request: Request) => Response | Promise<Response>) { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch }); servers.push(server); return server; }
const signal = () => new AbortController().signal;
function notice(source: Source, id = "a".repeat(64)): Notification { return { id, sequence: 1, sourceId: source.id, identity: sourceIdentity(source), thread: "12", text: "need a decision", state: "pending", createdAt: Date.now() }; }
async function until(predicate: () => boolean | Promise<boolean>) { const end = Date.now() + 10000; while (!await predicate()) { if (Date.now() > end) throw new Error("condition timed out"); await Bun.sleep(10); } }

test("configuration is bounded, explicit and disabled by default; missing workspace is an error", async () => {
  const f = await fixture(); expect(await loadCollaborationConfig(f.root)).toEqual({ enabled: false, sources: [] });
  await expect(parseCollaborationConfig({ ...f.raw, sources: [{ ...f.raw.sources[0], configuration: { ...f.raw.sources[0]!.configuration, allowWrite: true } }] })).rejects.toThrow("require checks");
  await expect(parseCollaborationConfig({ ...f.raw, sources: [{ ...f.raw.sources[0], token: "secret" }] })).rejects.toThrow("Unknown");
  await expect(parseCollaborationConfig({ ...f.raw, listen: { hostname: "0.0.0.0", port: 19998 } })).rejects.toThrow("loopback");
  await expect(parseCollaborationConfig({ ...f.raw, sources: [{ ...f.raw.sources[0], configuration: { ...f.raw.sources[0]!.configuration, domain: {} } }] })).rejects.toThrow("fixed");
  await writeFile(join(f.root, "collaboration.json"), JSON.stringify({ ...f.raw, sources: [{ ...f.raw.sources[0], configuration: { ...f.raw.sources[0]!.configuration, workspace: join(f.root, "missing") } }] }));
  await expect(loadCollaborationConfig(f.root)).rejects.toThrow("ENOENT");
  let output = "";
  expect(await runCollaborationCommand({ argv: ["collaboration", "--help"], cwd: f.root, env: {}, stdout: { write: text => { output += text; } }, stderr: { write: text => { throw new Error(text); } } })).toBe(0);
  expect(output).toContain("outbox-resolve");
});

test("webhook receipts are authenticated and bound to the notification ID; timers skip missed windows", async () => {
  const f = await fixture(); let calls = 0;
  const outbound = listen(async request => {
    const body = await request.text(); expect(authenticate(secret, request.headers.get("x-tnb-timestamp"), body, request.headers.get("x-tnb-signature"))).toBe(true);
    const input = JSON.parse(body); expect(request.headers.get("idempotency-key")).toBe(input.notificationId); calls++;
    return Response.json({ notificationId: input.notificationId, receipt: "bridge:confirmed" });
  });
  const source = f.config.sources[0]!; source.webhook!.outboundUrl = `${outbound.url}notify`;
  const port = new WebhookSource(source, env); expect(await port.send(notice(source), signal())).toBe("bridge:confirmed"); expect(calls).toBe(1);
  const timestamp = String(Date.now()), body = "payload";
  expect(authenticate(secret, timestamp, body, signature(secret, timestamp, body))).toBe(true);
  expect(authenticate(secret, String(Date.now() - 600000), body, signature(secret, timestamp, body))).toBe(false);
  expect(authenticate(secret, timestamp, `${body}!`, signature(secret, timestamp, body))).toBe(false);
  const timer = new TimerSource({ ...source, type: "timer", timer: { everyMs: 60000, objective: "Check the release", thread: "releases" } }, env);
  const first = await timer.poll("ancient-window"); expect(first.events).toHaveLength(1); expect(first.events[0]?.text).toBe("/tnb run Check the release");
  expect((await timer.poll(first.cursor)).events).toHaveLength(0);
});

test("GitHub paginates before advancing a watermark, verifies unknown receipts, and reads actual head CI/reviews", async () => {
  const f = await fixture(), source: Source = { ...f.config.sources[0]!, type: "github", github: { repository: "fixture/repo", tokenEnv: "GH_TOKEN" } }; delete source.webhook;
  let failSecond = false, pageTwo = 0; const n = notice(source), head = "b".repeat(40), since = new Date(Date.now() - 3600000).toISOString();
  const api = listen(request => {
    expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
    const url = new URL(request.url), page = Number(url.searchParams.get("page") ?? 1);
    if (url.pathname.endsWith("/issues/comments")) {
      if (page === 2) { pageTwo++; if (failSecond) return Response.json({}, { status: 503 }); }
      return Response.json(Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({ id: (page - 1) * 100 + index + 1, user: { login: "alice", type: "User" }, body: `/tnb run request-${page}-${index}`, issue_url: "https://api.github.com/repos/fixture/repo/issues/12" })));
    }
    if (url.pathname === "/user") return Response.json({ login: "tnb-bot" });
    if (url.pathname.endsWith("/issues/12/comments")) return Response.json([{ id: 901, user: { login: "impostor" }, body: notificationBody(n) }, { id: 902, user: { login: "tnb-bot" }, body: notificationBody(n) }]);
    if (url.pathname.endsWith("/pulls/9")) return Response.json({ number: 9, base: { repo: { full_name: "fixture/repo" } }, head: { sha: head }, state: "open", merged: false });
    if (url.pathname.endsWith(`/commits/${head}/check-runs`)) return Response.json({ check_runs: [{ name: "tests", status: "completed", conclusion: "success" }] });
    if (url.pathname.endsWith(`/commits/${head}/statuses`)) return Response.json([{ context: "lint", state: "success" }, { context: "lint", state: "pending" }]);
    if (url.pathname.endsWith("/pulls/9/reviews")) return Response.json([{ user: { login: "reviewer" }, state: "APPROVED", commit_id: head }]);
    return Response.json({ error: url.pathname }, { status: 404 });
  });
  const port = new GitHubSource(source, env, api.url.href.replace(/\/$/, ""));
  const cursor = JSON.stringify({ since, floor: since }), batch = await port.poll(cursor, signal());
  expect(batch.events).toHaveLength(101); expect(pageTwo).toBe(1); expect(JSON.parse(batch.cursor).since > since).toBe(true);
  failSecond = true; await expect(port.poll(cursor, signal())).rejects.toThrow("503");
  expect(await port.find(n, signal())).toBe("github-comment:902");
  const facts = await port.inspectPR(9, signal()); expect(facts.head).toBe(head); expect(facts.ci).toEqual([{ name: "tests", status: "completed", conclusion: "success" }, { name: "lint", status: "status", conclusion: "success" }]); expect(facts.reviews[0]?.commit).toBe(head);
});

test("the real daemon receives signed events, automatically returns questions/results and resumes after restart", async () => {
  const f = await fixture(), delivered: any[] = [];
  const outbound = listen(async request => { const input = await request.json(); delivered.push(input); return Response.json({ notificationId: input.notificationId, receipt: `fixture:${input.notificationId}` }); });
  const reserved = listen(() => new Response("reserved")), ingressPort = reserved.port!; await reserved.stop(true);
  f.raw.listen.port = ingressPort; f.raw.sources[0]!.webhook.outboundUrl = `${outbound.url}notify`;
  const configDir = join(f.root, "control"); await mkdir(configDir); await writeFile(join(configDir, "collaboration.json"), JSON.stringify(f.raw));
  const state = join(configDir, "runtime"), database = join(state, "state.sqlite"); let calls = 0;
  const factory = async () => ({ transport: { async *stream() {
    if (++calls === 1) {
      yield { type: "tool-start" as const, index: 0, id: "question", name: "durable_wait" };
      yield { type: "tool-input" as const, index: 0, json: JSON.stringify({ kind: "question", key: "db", question: "选择数据库", options: ["SQLite", "其他"], about: "答案之后继续" }) };
      yield { type: "response-end" as const, reason: "tool-use" as const };
    } else { yield { type: "text" as const, index: 0, text: "SQLite design delivered" }; yield { type: "response-end" as const, reason: "end-turn" as const }; }
  } }, model: "fixture", tools: [], authorize: async () => ({ behavior: "allow" as const }), route: { provider: "fixture", model: "fixture" }, maxOutputTokens: 128 });
  async function start() {
    const store = new RuntimeStore(database); stores.push(store); const runtime = new DurableRuntime(store, state, factory), controller = new AbortController(), ready = Promise.withResolvers<void>();
    const done = serveDurableRuntime({ configDir, runtime, env, signal: controller.signal, ready: () => ready.resolve() });
    cleanups.push(async () => { controller.abort(); await done; }); await Promise.race([ready.promise, done]); return { store, runtime, controller, done };
  }
  let owner = await start();
  const incoming = { externalId: "one", actor: "alice", thread: "chat-1", text: "/tnb run Design storage" };
  const send = async (input: unknown, authenticated = true) => {
    const body = JSON.stringify(input), timestamp = String(Date.now());
    return fetch(`http://127.0.0.1:${ingressPort}/sources/bridge/events`, { method: "POST", body, headers: authenticated ? { "x-tnb-timestamp": timestamp, "x-tnb-signature": signature(secret, timestamp, body) } : {} });
  };
  expect((await send(incoming, false)).status).toBe(403); expect(owner.store.runs()).toHaveLength(0);
  expect((await send(incoming)).status).toBe(202);
  await until(() => delivered.some(notice => notice.text.includes("/tnb answer")));
  const tickets = await runtimeRequest(configDir, "/collaboration?kind=tickets") as Array<{ value: Ticket }>;
  const ticket = tickets[0]!.value, question = owner.runtime.waits.questions(ticket.runId)[0]!;
  expect((await send(incoming)).status).toBe(202); expect(owner.store.runs()).toHaveLength(1);
  owner.controller.abort(); await owner.done; owner.store.close();
  owner = await start(); expect(owner.runtime.waits.questions(ticket.runId)[0]?.waitId).toBe(question.waitId);
  expect((await send({ ...incoming, externalId: "answer", text: `/tnb answer ${ticket.id} ${question.waitId} ${question.version} SQLite` })).status).toBe(202);
  await until(() => delivered.some(notice => notice.text.includes("report-delivered")));
  expect(owner.store.getRun(ticket.runId)?.status).toBe("succeeded"); expect(calls).toBe(2);
  expect(delivered.filter(notice => notice.text.includes("/tnb answer"))).toHaveLength(1);
  expect((await runtimeRequest(configDir, "/collaboration") as { enabled: boolean }).enabled).toBe(true);
}, 20000);

test("closing aborts and drains a source scan before returning; failures cannot advance its cursor", async () => {
  const f = await fixture(), store = new RuntimeStore(join(f.root, "control", "runtime", "state.sqlite")); stores.push(store);
  const runtime = new DurableRuntime(store, join(f.root, "control", "runtime"), async () => { throw new Error("unused"); });
  const entered = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>(); let drained = false;
  const config = { ...f.config, listen: undefined };
  const host = new CollaborationHost(runtime, config, env, new Map([["bridge", { async send() { return "none"; }, async poll(_cursor, signal) { entered.resolve(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); drained = true; stopped.resolve(); throw new Error("aborted"); } }]]));
  await host.start(); await entered.promise; await host.close(); await stopped.promise;
  expect(drained).toBe(true); expect(host.engine.cursor("bridge")).toBeUndefined();
});
