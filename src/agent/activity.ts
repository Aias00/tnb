import type { ModelEvent, RetryProgress } from "../providers/types";

/** Shared projection only; activity never grants execution or recovery authority. */
export type ExecutionActivity = { phase: "requesting" | "thinking" | "responding" | "preparing-tool" | "tool" | "retrying" | "finishing" | "waiting-approval" | "cancelling";
  startedAt: number; tool?: string; retry?: number; retryAt?: number; maxRetries?: number; retryReason?: RetryProgress["reason"]; status?: number; arguments?: true };
export class ExecutionActivityTracker {
  readonly tools = new Map<string, string>();
  value: ExecutionActivity;
  constructor(startedAt = Date.now()) { this.value = { phase: "requesting", startedAt }; }
  model(event: ModelEvent, now = Date.now()): ExecutionActivity {
    if (["cancelling", "waiting-approval"].includes(this.value.phase)) return this.value;
    const startedAt = this.value.startedAt;
    if (event.type === "text" || event.type === "thinking") this.value = { phase: event.type === "text" ? "responding" : "thinking", startedAt };
    if (event.type === "tool-start") this.value = { phase: "preparing-tool", tool: event.name.slice(0, 128), startedAt };
    if (event.type === "tool-input" && this.value.phase === "preparing-tool") this.value = { ...this.value, arguments: true };
    if (event.type === "response-end") this.value = { phase: event.reason === "tool-use" ? "preparing-tool" : "finishing", startedAt };
    if (event.type === "retry") this.value = { phase: event.phase === "waiting" ? "retrying" : "requesting", startedAt,
      retry: event.retry, maxRetries: event.maxRetries, retryReason: event.reason, status: event.status,
      ...(event.phase === "waiting" && Number.isFinite(event.delayMs) && event.delayMs >= 0 ? { retryAt: now + Math.min(event.delayMs, 3600000) } : {}) };
    if (this.tools.size) this.value = { phase: "tool", tool: this.tools.values().next().value, startedAt };
    return this.value;
  }
  tool(type: "start" | "end", id: string, name = "tool"): ExecutionActivity {
    if (type === "start") this.tools.set(id, name.slice(0, 128)); else this.tools.delete(id);
    if (["cancelling", "waiting-approval"].includes(this.value.phase)) return this.value;
    return this.resume();
  }
  set(phase: "waiting-approval" | "cancelling"): ExecutionActivity { return this.value = { phase, startedAt: this.value.startedAt }; }
  resume(): ExecutionActivity {
    if (this.value.phase === "cancelling") return this.value;
    const tool = this.tools.values().next().value;
    return this.value = { phase: tool ? "tool" : "requesting", ...(tool ? { tool } : {}), startedAt: this.value.startedAt };
  }
}
export function executionActivityLabel(value: ExecutionActivity, now = Date.now()): string {
  if (value.phase === "retrying") return `${value.retryReason === "rate-limit" ? "Rate limited" : value.retryReason === "connection" ? "Connection failed" : "Provider unavailable"}${value.status ? ` (${value.status})` : ""} · retry ${value.retry}/${value.maxRetries} in ${Math.max(0, Math.ceil(((value.retryAt ?? now) - now) / 1000))}s`;
  if (value.phase === "requesting" && value.retry) return `Retrying model · ${value.retry}/${value.maxRetries}`;
  return { requesting: "Requesting model", thinking: "Thinking", responding: "Writing response", "preparing-tool": value.tool ? `Preparing ${value.tool}${value.arguments ? " arguments" : ""}` : "Preparing tools",
    tool: `Running ${value.tool ?? "tool"}`, finishing: "Finishing response", "waiting-approval": "Waiting for permission", cancelling: "Cancelling…" }[value.phase];
}
