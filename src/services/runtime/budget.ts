import { randomUUID } from "node:crypto";
import type { ModelTransport, ModelRequest, ModelEvent } from "../../providers/types";
import { UsageBudget, type BillingRoute } from "../usage/budget";
import { calculateCostUsd } from "../usage/cost";
import { RuntimeStore } from "./store";

type RequestCharge = { requestId: string; reserved: number; reported: number; state: "pending" | "complete" | "uncertain"; usageCount: number };
export class DurableBudget {
  readonly #gate = new UsageBudget({ maxConcurrentRequests: 8 });
  readonly #runGates = new Map<string, UsageBudget>();
  constructor(readonly store: RuntimeStore) {}
  totals(runId: string): { reported: number; reserved: number; uncertain: number } {
    return this.store.records<RequestCharge>("model-request", runId).reduce((sum, row) => {
      sum.reported += row.value.reported;
      if (row.value.state !== "complete") sum.reserved += Math.max(0, row.value.reserved - row.value.reported);
      if (row.value.state === "uncertain") sum.uncertain++;
      return sum;
    }, { reported: 0, reserved: 0, uncertain: 0 });
  }
  wrap(raw: ModelTransport, context: { runId: string; taskId: string; route: BillingRoute; maxCostUsd?: number; maxOutputTokens: number; assertLive(): void }): ModelTransport {
    const budget = this;
    let runGate = this.#runGates.get(context.runId);
    if (!runGate) { runGate = new UsageBudget({ maxConcurrentRequests: 4 }); this.#runGates.set(context.runId, runGate); }
    const durable: ModelTransport = { async *stream(request: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelEvent> {
      signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000);
      context.assertLive(); signal?.throwIfAborted();
      const requestId = randomUUID();
      const reserve = context.route.pricing ? calculateCostUsd({ inputTokens: Buffer.byteLength(JSON.stringify(request)),
        outputTokens: context.maxOutputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, context.route.pricing) : 0;
      if (context.maxCostUsd !== undefined && !context.route.pricing) throw new Error("Durable dollar budgets require configured model pricing");
      budget.store.command(randomUUID(), { kind: "budget.reserve", requestId }, Date.now(), (tx) => {
        const totals = budget.totals(context.runId);
        if (context.maxCostUsd !== undefined && totals.reported + totals.reserved + reserve > context.maxCostUsd) throw new Error("Durable run budget exhausted (including uncertain reservations)");
        tx.saveRecord<RequestCharge>({ kind: "model-request", id: requestId, runId: context.runId, taskId: context.taskId,
          value: { requestId, reserved: reserve, reported: 0, state: "pending", usageCount: 0 } }, 0);
        tx.event(context.runId, "budget.reserved", { requestId, reserve }, context.taskId);
        return true;
      });
      let complete = false; let count = 0; let seenUsage = false; let responseBytes = 0;
      try {
        for await (const event of raw.stream({ ...request, maxOutputTokens: context.maxOutputTokens }, signal)) {
          responseBytes += JSON.stringify(event).length;
          if (responseBytes > 2 * 1024 * 1024) throw new Error("Model response byte limit exceeded");
          if (event.type === "usage") {
            if ([event.usage.inputTokens, event.usage.outputTokens, event.usage.cacheReadInputTokens, event.usage.cacheCreationInputTokens]
              .some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid provider usage counters");
            seenUsage = true;
            const cost = calculateCostUsd(event.usage, (event.billing ?? context.route).pricing);
            const sequence = count++;
            budget.store.command(`${requestId}:${sequence}`, { kind: "budget.usage", event }, Date.now(), (tx) => {
              const record = tx.record<RequestCharge>("model-request", requestId)!;
              tx.saveRecord({ ...record, value: { ...record.value, reported: record.value.reported + cost, usageCount: sequence + 1 } }, record.revision);
              tx.event(context.runId, "budget.reported", { requestId, sequence, cost }, context.taskId);
              return true;
            });
          }
          if (event.type === "response-end") complete = true;
          yield event;
          context.assertLive();
          if (context.maxCostUsd !== undefined && budget.totals(context.runId).reported >= context.maxCostUsd) throw new Error("Durable run reported budget exhausted");
        }
      } finally {
        budget.store.command(randomUUID(), { kind: "budget.finish", requestId, complete }, Date.now(), (tx) => {
          const record = tx.record<RequestCharge>("model-request", requestId)!;
          tx.saveRecord({ ...record, value: { ...record.value, state: complete && seenUsage ? "complete" : "uncertain" } }, record.revision);
          return true;
        });
      }
    } };
    // Reserve only after both gates admit a physical request, and persist usage before
    // cancellation in an outer gate can stop delivery to the model loop.
    return runGate.wrap(this.#gate.wrap(durable, () => context.route), () => context.route);
  }
  recover(runId: string): void {
    for (const record of this.store.records<RequestCharge>("model-request", runId)) {
      if (record.value.state !== "pending") continue;
      this.store.command(randomUUID(), { kind: "budget.recover", id: record.id }, Date.now(), (tx) => {
        const current = tx.record<RequestCharge>("model-request", record.id)!;
        tx.saveRecord({ ...current, value: { ...current.value, state: "uncertain" } }, current.revision);
        return true;
      });
    }
  }
  async close(): Promise<void> { await Promise.all([...this.#runGates.values()].map((gate) => gate.close())); await this.#gate.close(); }
}
