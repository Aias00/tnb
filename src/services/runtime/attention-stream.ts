import type { DurableRuntime, RuntimeConfiguration } from "./engine-core";
import type { InboxQuestion } from "./attention";
import type { RoutingDecision } from "./routing";
import { pendingRunNotices } from "./notices";
import { presentRuns } from "./presentation";

/** A reconnect always starts with authoritative open questions, so no event cursor can lose a decision. */
export function questionAttentionResponse(runtime: DurableRuntime, workspace: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {}, cleanup = () => {};
  let send = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false, previous: string | undefined;
      const snapshot = () => {
        const questions: InboxQuestion[] = [];
        page: for (const run of runtime.store.runs()) {
          if (runtime.store.record<RuntimeConfiguration>("configuration", run.runId)?.value.workspace !== workspace) continue;
          for (const question of runtime.waits.questions(run.runId)) {
            questions.push({ ...question, runObjective: run.objective, runStatus: run.status });
            if (questions.length === 64) break page; // Answering advances the bounded snapshot to the next decisions.
          }
        }
        for (const decision of runtime.store.routes<RoutingDecision>(workspace, { pendingOnly: true, actionableOnly: true, limit: 32 })) {
          questions.push({ ...decision, routing: true, version: decision.revision });
        }
        return JSON.stringify({ workspace, questions, runs: presentRuns(runtime, workspace), notifications: pendingRunNotices(runtime, workspace), lifecycleNotifications: true, ready: !runtime.lastError });
      };
      send = () => {
        if (closed || (controller.desiredSize ?? 0) <= 0) return;
        const data = snapshot();
        if (data === previous) return;
        previous = data; controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };
      const heartbeat = setInterval(() => {
        send(); // Expired questions must disappear even while a Run is already paused.
        if (!closed && (controller.desiredSize ?? 0) > 0) controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 15_000); heartbeat.unref();
      cleanup = () => {
        if (closed) return;
        closed = true; clearInterval(heartbeat); unsubscribe(); signal.removeEventListener("abort", abort);
      };
      const abort = () => { cleanup(); try { controller.close(); } catch { /* The peer may already have cancelled. */ } };
      unsubscribe = runtime.store.onChange(send);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else send();
    },
    pull() { send(); },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
