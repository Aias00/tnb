import { afterEach, expect, test } from "bun:test";
import { connect } from "node:net";
import { createWebWorkbench } from "../../src/plugins/web/server";
import type { TaskService, WorkspaceTaskService } from "../../src/agent/task-service";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(options: { now?: () => number; sessionTtlMs?: number } = {}) {
  let calls = 0, streams = 0;
  const tasks: TaskService = { async open(workspace) { return { workspace, info: async () => ({ workspace, coding: true, models: [], defaults: { provider: "fixture", model: "fixture" } }),
    list: () => [], detail: async () => { throw new Error("not found"); }, events: () => [], command: async () => { calls++; return { ok: true }; },
    attention(signal, onClose) { streams++; let done = false;
      const finish = () => { if (done) return; done = true; streams--; onClose?.(); };
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"questions":[]}\n\n')); signal.addEventListener("abort", () => { finish(); try { controller.close(); } catch {} }, { once: true }); }, cancel: finish }));
    },
  } satisfies WorkspaceTaskService; } };
  const host = createWebWorkbench({ tasks, ...options }); cleanup.push(host.close);
  return { host, calls: () => calls, streams: () => streams };
}
async function login(link: Awaited<ReturnType<ReturnType<typeof createWebWorkbench>["launch"]>>) {
  const url = new URL(link.url), code = new URLSearchParams(url.hash.slice(1)).get("code"), base = url.origin + url.pathname;
  const exchange = await fetch(base + "auth/exchange", { method: "POST", headers: { origin: url.origin, "content-type": "application/json" }, body: JSON.stringify({ code }) });
  expect(exchange.status).toBe(200);
  return { base, origin: url.origin, code, cookie: exchange.headers.get("set-cookie")!.split(";")[0]!, setCookie: exchange.headers.get("set-cookie")! };
}

test("web listener exchanges single-use links for scoped HttpOnly sessions and enforces Origin/Host", async () => {
  const f = fixture(), link = await f.host.launch("workspace-a"), url = new URL(link.url), base = url.origin + url.pathname;
  const page = await fetch(base); expect(page.status).toBe(200); expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'"); expect(await page.text()).not.toContain(url.hash);
  expect((await fetch(base + "api/info")).status).toBe(401);
  const session = await login(link); expect(session.setCookie).toContain("HttpOnly"); expect(session.setCookie).toContain("SameSite=Strict"); expect(session.setCookie).toContain("Path=" + url.pathname);
  expect((await fetch(base + "api/info", { headers: { cookie: session.cookie } })).status).toBe(200);
  const post = (headers: Record<string, string>, path = "api/command", body = {}) => fetch(base + path, { method: "POST", headers: { cookie: session.cookie, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  expect((await post({})).status).toBe(403); expect((await post({ origin: "https://evil.example" })).status).toBe(403);
  expect((await post({ origin: session.origin, "sec-fetch-site": "cross-site" })).status).toBe(403);
  const rebinding = await new Promise<number>((resolve, reject) => {
    const client = connect(Number(url.port), "127.0.0.1"); let output = "";
    client.on("connect", () => client.write("POST " + url.pathname + "api/command HTTP/1.1\r\nHost: evil.example\r\nOrigin: " + session.origin + "\r\nCookie: " + session.cookie + "\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"));
    client.on("data", bytes => { output += bytes.toString(); }); client.on("error", reject); client.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(output)?.[1])));
  });
  expect(rebinding).toBe(403);
  expect((await post({ origin: session.origin }, "auth/exchange", { code: session.code })).status).toBe(401);
  expect(f.calls()).toBe(0);
  expect((await post({ origin: session.origin })).status).toBe(200); expect(f.calls()).toBe(1);
});

test("web sessions stay in their launched workspace and expired links/sessions are refused", async () => {
  let now = Date.now(); const f = fixture({ now: () => now, sessionTtlMs: 1000 });
  const a = await login(await f.host.launch("workspace-a")), bLink = await f.host.launch("workspace-b"), bUrl = new URL(bLink.url);
  expect((await fetch(bUrl.origin + bUrl.pathname + "api/info", { headers: { cookie: a.cookie } })).status).toBe(401);
  const b = await login(bLink); expect(b.setCookie).not.toContain(new URL(a.base).pathname);
  now += 1001; expect((await fetch(a.base + "api/info", { headers: { cookie: a.cookie } })).ok).toBe(false);
  const expired = await f.host.launch("workspace-c"); now += 60001;
  const url = new URL(expired.url);
  expect((await fetch(url.origin + url.pathname + "auth/exchange", { method: "POST", headers: { origin: url.origin, "content-type": "application/json" }, body: JSON.stringify({ code: new URLSearchParams(url.hash.slice(1)).get("code") }) })).ok).toBe(false);
});

test("logout and plugin shutdown close authoritative attention streams and reject later commands", async () => {
  const f = fixture(), session = await login(await f.host.launch("workspace-a"));
  const response = await fetch(session.base + "api/attention", { headers: { cookie: session.cookie } }), reader = response.body!.getReader();
  expect((await reader.read()).done).toBe(false); expect(f.streams()).toBe(1);
  expect((await fetch(session.base + "auth/logout", { method: "POST", headers: { cookie: session.cookie, origin: session.origin, "content-type": "application/json" }, body: "{}" })).status).toBe(200);
  expect((await reader.read()).done).toBe(true); expect(f.streams()).toBe(0);
  expect((await fetch(session.base + "api/info", { headers: { cookie: session.cookie } })).ok).toBe(false);
  await f.host.close();
  const refused = await new Promise<boolean>(resolve => { const socket = connect(Number(new URL(session.base).port), "127.0.0.1"); socket.on("connect", () => { socket.destroy(); resolve(false); }); socket.on("error", () => resolve(true)); });
  expect(refused).toBe(true);
});


test("a browser session bounds concurrent attention streams and releases its slots on disconnect", async () => {
  const f = fixture(), session = await login(await f.host.launch("workspace-a"));
  const clients: AbortController[] = [];
  for (let index = 0; index < 4; index++) {
    const controller = new AbortController(); clients.push(controller);
    const response = await fetch(session.base + "api/attention", { headers: { cookie: session.cookie }, signal: controller.signal });
    expect(response.status).toBe(200); await response.body!.getReader().read();
  }
  expect((await fetch(session.base + "api/attention", { headers: { cookie: session.cookie } })).status).toBe(429);
  clients[0]!.abort();
  const end = Date.now() + 1000; while (f.streams() === 4 && Date.now() < end) await Bun.sleep(5);
 expect(f.streams()).toBe(3);
  for (const client of clients) client.abort(); await f.host.close(); expect(f.streams()).toBe(0);
});
