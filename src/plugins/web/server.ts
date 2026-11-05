import { randomBytes, timingSafeEqual } from "node:crypto";
import { digestJson } from "../../services/runtime/json";
import type { TaskService, WorkspaceTaskService } from "../../agent/task-service";
import { page, script, style } from "./assets";

type Session = { scope: string; expires: number; controller: AbortController; expiry: AbortSignal; streams: Set<AbortController> };
const key = () => randomBytes(32).toString("hex");
const same = (left: string, right: string) => { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };

/** Browser-facing listener owned by an interface plugin, never the private runtime RPC. */
export function createWebWorkbench(options: { tasks: TaskService; signal?: AbortSignal; now?: () => number; sessionTtlMs?: number }) {
  const now = options.now ?? Date.now;
  const lifetime = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  const scopes = new Map<string, WorkspaceTaskService>(), tickets = new Map<string, { scope: string; expires: number }>(), sessions = new Map<string, Session>();
  const pending = new Set<Promise<Response>>();
  let server: ReturnType<typeof Bun.serve> | undefined, origin = "", closing = false;
  let closingPromise: Promise<void> | undefined;
  const removeSession = (token: string) => { sessions.get(token)?.controller.abort(); sessions.delete(token); };
  const prune = () => {
    for (const [token, session] of sessions) if (session.expires <= now()) removeSession(token);
    for (const [token, ticket] of tickets) if (ticket.expires <= now()) tickets.delete(token);
    for (const scope of scopes.keys()) if (![...tickets.values(), ...sessions.values()].some(item => item.scope === scope)) scopes.delete(scope);
  };
  const json = (value: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(value, { status, headers: { ...headers, ...extra } });
  async function handle(request: Request): Promise<Response> {
    if (closing || signal.aborted) return json({ error: "工作台正在关闭" }, 503);
    prune();
    const url = new URL(request.url), expected = new URL(origin), suppliedOrigin = request.headers.get("origin");
    if (url.origin !== origin || request.headers.get("host") !== expected.host || suppliedOrigin && suppliedOrigin !== origin
      || ["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "")) return json({ error: "请求来源不匹配" }, 403);
    if (request.method !== "GET" && (request.method !== "POST" || suppliedOrigin !== origin || request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")) return json({ error: "需要同源 JSON 请求" }, 403);
    const match = /^\/w\/([a-f0-9]{32})\/(.*)$/.exec(url.pathname);
    const scope = match?.[1] ?? "", resource = match?.[2] ?? "", tasks = scopes.get(scope);
    if (!match) return json({ error: "未知工作台入口" }, 404);
    if (request.method === "GET" && ["", "app.js", "app.css"].includes(resource)) return new Response(resource === "" ? page : resource === "app.js" ? script : style,
      { headers: { ...headers, "content-type": resource === "" ? "text/html; charset=utf-8" : resource === "app.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8" } });
    if (!tasks) return json({ error: "工作区入口已失效，请重新运行 tnb web" }, 404);
    if (request.method === "POST" && resource === "auth/exchange") {
      const input = await request.json() as { code?: unknown };
      if (!input || typeof input.code !== "string") return json({ error: "无效授权码" }, 401);
      const ticket = tickets.get(input.code);
      if (!ticket || ticket.scope !== scope || ticket.expires <= now()) return json({ error: "授权链接已使用或过期，请重新运行 tnb web" }, 401);
      if (sessions.size >= 64) return json({ error: "会话数量已达上限" }, 429);
      tickets.delete(input.code);
      const previous = cookie(request); if (sessions.get(previous)?.scope === scope) removeSession(previous);
      const token = key(), ttl = options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
      sessions.set(token, { scope, expires: now() + ttl, controller: new AbortController(), expiry: AbortSignal.timeout(ttl), streams: new Set() });
      return json({ authenticated: true }, 200, { "set-cookie": `tnb_web=${token}; HttpOnly; SameSite=Strict; Path=/w/${scope}/; Max-Age=${Math.ceil(ttl / 1000)}` });
    }
    const token = cookie(request), session = sessions.get(token);
    if (!session || !same(session.scope, scope) || session.expires <= now()) return json({ error: "会话已过期，请重新运行 tnb web" }, 401);
    const requestSignal = AbortSignal.any([signal, session.controller.signal, request.signal, session.expiry]);
    if (request.method === "POST" && resource === "auth/logout") {
      removeSession(token); return json({ signedOut: true }, 200, { "set-cookie": `tnb_web=; HttpOnly; SameSite=Strict; Path=/w/${scope}/; Max-Age=0` });
    }
    if (request.method === "GET") {
      if (resource === "api/info") return json(await tasks.info());
      if (resource === "api/runs") return json(tasks.list());
      if (resource === "api/attention") {
        if (session.streams.size >= 4) return json({ error: "此会话的实时连接已达上限" }, 429);
        const controller = new AbortController(), linked = AbortSignal.any([requestSignal, controller.signal]);
        session.streams.add(controller);
        let done = false;
        const cleanup = () => { if (done) return; done = true; session.streams.delete(controller); linked.removeEventListener("abort", cleanup); controller.abort(); };
        linked.addEventListener("abort", cleanup, { once: true });
        let response: Response;
        try { response = tasks.attention(linked, cleanup); } catch (error) { cleanup(); throw error; }
        return new Response(response.body, { headers: { ...headers, "content-type": "text/event-stream" } });
      }
      const detail = /^api\/runs\/([^/]+)(\/events)?$/.exec(resource);
      if (detail) return json(detail[2] ? tasks.events(decodeURIComponent(detail[1]!), Number(url.searchParams.get("after") ?? 0)) : await tasks.detail(decodeURIComponent(detail[1]!)));
    }
    if (request.method === "POST" && resource === "api/command") return json(await tasks.command(await request.json(), requestSignal));
    return json({ error: "未知工作台接口" }, 404);
  }
  const close = () => closingPromise ??= (async () => {
    closing = true; lifetime.abort();
    for (const token of sessions.keys()) removeSession(token);
    tickets.clear(); scopes.clear();
    // Let abort-driven stream closures reach Bun's HTTP transport before joining stop.
    await new Promise<void>(resolve => setImmediate(resolve));
    await server?.stop(true); await Promise.allSettled([...pending]); server = undefined;
  })();
  return {
    async launch(workspace: string, port?: number) {
      signal.throwIfAborted();
      if (port !== undefined && (!Number.isSafeInteger(port) || port < 0 || port > 65535)) throw new Error("Invalid local HTTP port");
      const tasks = await options.tasks.open(workspace); signal.throwIfAborted(); prune();
      const scope = digestJson(tasks.workspace).slice(0, 32);
      if (!scopes.has(scope) && scopes.size >= 32 || tickets.size >= 64) throw new Error("工作台入口数量已达上限");
      if (server && port && server.port !== port) throw new Error(`工作台已监听 ${server.port}，请使用现有端口`);
      if (!server) {
        server = Bun.serve({ hostname: "127.0.0.1", port: port ?? 0, maxRequestBodySize: 128 * 1024, idleTimeout: 30,
          fetch(request) {
            const work = handle(request).catch(error => json({ error: error instanceof Error ? error.message : String(error) }, 400));
            pending.add(work); void work.finally(() => pending.delete(work)); return work;
          },
        });
        origin = `http://127.0.0.1:${server.port}`;
      }
      scopes.set(scope, tasks); const code = key(); tickets.set(code, { scope, expires: now() + 60_000 });
      return { url: `${origin}/w/${scope}/#code=${code}`, workspace: tasks.workspace, origin };
    },
    close,
    status: () => ({ listening: !!server, origin, workspaces: scopes.size, sessions: sessions.size }),
  };
}
function cookie(request: Request): string {
  return request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith("tnb_web="))?.slice("tnb_web=".length) ?? "";
}
