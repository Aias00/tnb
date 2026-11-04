import type { DurableRuntime, RuntimeConfiguration } from "./engine";
import type { QuestionNotice } from "./attention";
import { pendingRunNotices } from "./notices";

/** A reconnect always starts with authoritative open questions, so no event cursor can lose a decision. */
export function questionAttentionResponse(runtime: DurableRuntime, workspace: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let unsubscribe = () => {}, cleanup = () => {};
  let send = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false, previous: string | undefined;
      const snapshot = () => {
        const questions: QuestionNotice[] = [];
        page: for (const run of runtime.store.runs()) {
          if (runtime.store.record<RuntimeConfiguration>("configuration", run.runId)?.value.workspace !== workspace) continue;
          for (const question of runtime.waits.questions(run.runId)) {
            questions.push({ ...question, runObjective: run.objective, runStatus: run.status });
            if (questions.length === 64) break page; // Answering advances the bounded snapshot to the next decisions.
          }
        }
        return JSON.stringify({ workspace, questions, notifications: pendingRunNotices(runtime, workspace), lifecycleNotifications: true, ready: !runtime.lastError });
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
