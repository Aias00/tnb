import type { ModelEvent, ModelRequest, ModelTransport, TokenUsage } from "../../providers/types";
import { addUsage, calculateCostUsd, EMPTY_USAGE, type ModelPricing, type UsageTotals } from "./cost";

export type BillingRoute = { provider: string; model: string; pricing?: ModelPricing };
export type UsageRecord = { provider: string; model: string; usage: TokenUsage; costUsd: number };

/** One invocation owns this ledger, including all delegated and maintenance requests.
 * The ceiling stops admission on reported spend, not on estimated/prepaid spend.
 */
export class UsageBudget {
  readonly #abort = new AbortController();
  readonly #active = new Set<Promise<void>>();
  readonly #leases = new Set<Promise<void>>();
  #totals: UsageTotals = { ...EMPTY_USAGE };
  #closed = false;
  #finished = false;

  constructor(readonly options: {
    maxCostUsd?: number;
    onUsage?(record: UsageRecord): Promise<void>;
  } = {}) {
    if (options.maxCostUsd !== undefined && (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0)) {
      throw new Error("Budget must be a positive finite dollar amount");
    }
  }

  get signal(): AbortSignal { return this.#abort.signal; }
  get totals(): UsageTotals { return { ...this.#totals }; }

  /** Background activations keep their originating budget after the parent returns. */
  retain(): () => void {
    if (this.#finished || this.#closed) throw new Error("Invocation budget is closed to new activations");
    let resolve!: () => void;
    const lease = new Promise<void>((done) => { resolve = done; });
    this.#leases.add(lease);
    return () => { this.#leases.delete(lease); resolve(); };
  }

  async finish(): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    if (!this.#leases.size) { await this.close(); return; }
    // Managed background tasks remain asynchronous; their last release closes admission.
    void Promise.all([...this.#leases]).then(() => this.close());
  }

  wrap(transport: ModelTransport, routeFor: (request: ModelRequest) => BillingRoute): ModelTransport {
    const budget = this;
    return {
      async *stream(request, signal): AsyncGenerator<ModelEvent> {
        budget.signal.throwIfAborted();
        if (budget.#closed) throw new Error("Invocation budget is closed");
        const route = routeFor(request);
        budget.#requirePricing(route);
        const combined = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
        combined.throwIfAborted();
        let finish!: () => void;
        const active = new Promise<void>((resolve) => { finish = resolve; });
        budget.#active.add(active);
        try {
          for await (const event of transport.stream(request, combined)) {
            if (event.type !== "usage") { combined.throwIfAborted(); yield event; continue; }
            // Factory attribution is per physical route, including concurrent fallback calls.
            const billing = event.billing ?? route;
            budget.#requirePricing(billing);
            const costUsd = calculateCostUsd(event.usage, billing.pricing);
            const usage = { ...event.usage, costUsd };
            budget.#totals = addUsage(budget.#totals, usage) as UsageTotals;
            const exceeded = budget.options.maxCostUsd !== undefined && budget.#totals.costUsd >= budget.options.maxCostUsd;
            if (exceeded) budget.#abort.abort(new Error(
              `Maximum budget of $${budget.options.maxCostUsd!.toFixed(2)} reached (reported: $${budget.#totals.costUsd.toFixed(4)})`,
            ));
            // Persist even when this usage crosses the ceiling or another request aborted us.
            try { await budget.options.onUsage?.({ provider: billing.provider, model: billing.model, usage, costUsd }); }
            catch (error) { budget.#abort.abort(error); throw error; }
            combined.throwIfAborted();
            yield { ...event, usage };
          }
          combined.throwIfAborted();
        } finally {
          budget.#active.delete(active);
          finish();
        }
      },
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#abort.abort(new Error("Invocation ended"));
    await Promise.all([...this.#active]);
  }

  #requirePricing(route: BillingRoute): void {
    if (this.options.maxCostUsd !== undefined && !route.pricing) {
      throw new Error(`--max-budget-usd requires pricing for ${route.provider}/${route.model}`);
    }
  }
}
