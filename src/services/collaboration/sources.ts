import { createHmac, timingSafeEqual } from "node:crypto";
import { integer, text } from "../runtime/json";
import type { IncomingEvent, Notification, PullRequestFacts, Source, SourcePort } from "./types";

export function signature(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}
export function authenticate(secret: string, timestamp: string | null, body: string, supplied: string | null, now = Date.now()): boolean {
  if (!timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300000 || !supplied || !/^[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(signature(secret, timestamp, body), "hex"), Buffer.from(supplied, "hex"));
}
export function credential(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]; if (!value || value.length < 16) throw new Error(`Missing or too short collaboration credential environment variable: ${name}`);
  return value;
}
export async function responseJson(response: Response, maxBytes = 2 * 1024 * 1024): Promise<any> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Source HTTP ${response.status}`); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("Source response has no body");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maxBytes) throw new Error("Source response exceeds byte limit"); chunks.push(next.value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => undefined); }
}
const networkSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(10000)]);
export class WebhookSource implements SourcePort {
  constructor(readonly source: Source, readonly env: Record<string, string | undefined>) { credential(env, source.webhook!.secretEnv); }
  async send(notification: Notification, signal: AbortSignal): Promise<string> {
    const body = JSON.stringify({ notificationId: notification.id, thread: notification.thread, ticketId: notification.ticketId, text: notification.text });
    const timestamp = String(Date.now()), secret = credential(this.env, this.source.webhook!.secretEnv);
    const response = await fetch(this.source.webhook!.outboundUrl, { method: "POST", redirect: "error", signal: networkSignal(signal), body,
      headers: { "content-type": "application/json", "idempotency-key": notification.id, "x-tnb-timestamp": timestamp, "x-tnb-signature": signature(secret, timestamp, body) } });
    const result = await responseJson(response, 8192);
    if (result.notificationId !== notification.id) throw new Error("Webhook receipt does not match notification identity");
    return text(result.receipt, "webhook receipt", 512);
  }
}
export class TimerSource extends WebhookSource {
  async poll(cursor: string | undefined): Promise<{ events: IncomingEvent[]; cursor: string }> {
    const timer = this.source.timer!, window = String(Math.floor(Date.now() / timer.everyMs));
    return { events: cursor === window ? [] : [{ externalId: `window:${window}`, actor: "timer", thread: timer.thread, text: `/tnb run ${timer.objective}` }], cursor: window };
  }
}
export const notificationBody = (notification: Notification) => `${notification.text}\n\n<!-- tnb-notification:${notification.id} -->`;

/** API base is constructor injection for local fixtures only, never an incoming/configured URL. */
export class GitHubSource implements SourcePort {
  #login?: string;
  constructor(readonly source: Source, readonly env: Record<string, string | undefined>, readonly api = "https://api.github.com") { credential(env, source.github!.tokenEnv); }
  async request(path: string, signal: AbortSignal, body?: unknown): Promise<any> {
    const response = await fetch(`${this.api}${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: networkSignal(signal),
      headers: { authorization: `Bearer ${credential(this.env, this.source.github!.tokenEnv)}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "tnb-collaboration", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return responseJson(response);
  }
  async pages(path: string, signal: AbortSignal): Promise<any[]> {
    const items: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await this.request(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, signal);
      const values = Array.isArray(batch) ? batch : batch.check_runs;
      if (!Array.isArray(values) || values.length > 100) throw new Error("Invalid GitHub page");
      items.push(...values);
      if (values.length < 100) return items;
    }
    throw new Error("GitHub scan capacity exceeded; cursor was not advanced");
  }
  repo(): string { return `/repos/${this.source.github!.repository}`; }
  async poll(cursor: string | undefined, signal: AbortSignal): Promise<{ events: IncomingEvent[]; cursor: string }> {
    const now = Date.now(), saved = cursor ? JSON.parse(cursor) as { since: string; floor: string } : { since: new Date(now).toISOString(), floor: new Date(now).toISOString() };
    if (!Number.isFinite(Date.parse(saved.since)) || !Number.isFinite(Date.parse(saved.floor))) throw new Error("Invalid GitHub Source cursor");
    const since = new Date(Math.max(Date.parse(saved.floor), Date.parse(saved.since) - 300000)).toISOString();
    const comments = await this.pages(`${this.repo()}/issues/comments?sort=updated&direction=asc&since=${encodeURIComponent(since)}`, signal);
    const events: IncomingEvent[] = [];
    for (const comment of comments) {
      if (comment.user?.type === "Bot" || typeof comment.body !== "string" || comment.body.includes("<!-- tnb-notification:") || !comment.body.trim()) continue;
      const issue = /\/issues\/([1-9]\d*)$/.exec(comment.issue_url ?? "");
      if (!issue || !Number.isSafeInteger(comment.id) || typeof comment.user?.login !== "string") throw new Error("Malformed GitHub comment identity");
      events.push({ externalId: String(comment.id), actor: comment.user.login, thread: issue[1]!, text: comment.body });
    }
    return { events, cursor: JSON.stringify({ since: new Date(now).toISOString(), floor: saved.floor }) };
  }
  async send(notification: Notification, signal: AbortSignal): Promise<string> {
    integer(Number(notification.thread), "GitHub thread", 1);
    const result = await this.request(`${this.repo()}/issues/${notification.thread}/comments`, signal, { body: notificationBody(notification) });
    if (!Number.isSafeInteger(result.id) || result.id < 1 || result.body !== notificationBody(notification)) throw new Error("Invalid GitHub comment receipt");
    return `github-comment:${result.id}`;
  }
  async find(notification: Notification, signal: AbortSignal): Promise<string | undefined> {
    this.#login ??= text((await this.request("/user", signal)).login, "GitHub login", 128);
    const comments = await this.pages(`${this.repo()}/issues/${notification.thread}/comments`, signal);
    const found = comments.find(comment => comment.body === notificationBody(notification) && comment.user?.login === this.#login && Number.isSafeInteger(comment.id));
    return found ? `github-comment:${found.id}` : undefined;
  }
  async inspectPR(number: number, signal: AbortSignal): Promise<PullRequestFacts> {
    integer(number, "PR number", 1);
    const pr = await this.request(`${this.repo()}/pulls/${number}`, signal), head = pr.head?.sha;
    if (pr.number !== number || pr.base?.repo?.full_name?.toLowerCase() !== this.source.github!.repository.toLowerCase() || typeof head !== "string" || !/^[a-f0-9]{40,64}$/.test(head) || !["open", "closed"].includes(pr.state)) throw new Error("PR repository/head identity mismatch");
    const results = await Promise.allSettled([
      this.pages(`${this.repo()}/commits/${head}/check-runs?filter=latest`, signal),
      this.pages(`${this.repo()}/commits/${head}/statuses`, signal),
      this.pages(`${this.repo()}/pulls/${number}/reviews`, signal),
    ]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const [checks, statuses, reviews] = results.map(result => (result as PromiseFulfilledResult<any[]>).value);
    const latest = new Map<string, any>();
    for (const status of statuses!) if (!latest.has(status.context)) latest.set(status.context, status);
    return { number, head, state: pr.state, merged: pr.merged === true, url: `https://github.com/${this.source.github!.repository}/pull/${number}`,
      ci: [...checks!.map(check => ({ name: String(check.name).slice(0, 256), status: String(check.status).slice(0, 64), conclusion: check.conclusion === null ? null : String(check.conclusion).slice(0, 64) })),
        ...[...latest.values()].map(status => ({ name: String(status.context).slice(0, 256), status: "status", conclusion: String(status.state).slice(0, 64) }))].slice(0, 128),
      reviews: reviews!.slice(-128).map(review => ({ actor: String(review.user?.login).slice(0, 128), state: String(review.state).slice(0, 64), commit: typeof review.commit_id === "string" ? review.commit_id : null })) };
  }
}
export function sourcePorts(sources: Source[], env: Record<string, string | undefined>): Map<string, SourcePort> {
  return new Map(sources.map(source => [source.id, source.type === "github" ? new GitHubSource(source, env) : source.type === "timer" ? new TimerSource(source, env) : new WebhookSource(source, env)]));
}
