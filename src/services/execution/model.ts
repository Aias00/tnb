import type { ProviderSelection } from "../../providers/config";
import { createConfiguredTransportWithFallback, resolveBillingRoute, type ReasoningEffort } from "../../providers/factory";
import type { ModelTransport } from "../../providers/types";
import type { UsageBudget } from "../usage/budget";

export type ModelExecutionOptions = {
  selection: ProviderSelection;
  fallbackSelection?: ProviderSelection;
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
  maxRetries?: number;
  transport?: ModelTransport;
  /** Borrowed invocation ledger; its caller owns cancellation and disposal. */
  budget?: UsageBudget;
  workspace?: string;
};

/** Shared host assembly. The kernel receives only the resulting model transport. */
export function createModelExecution(options: ModelExecutionOptions) {
  const { selection } = options;
  let configured = options.transport;
  const raw: ModelTransport = {
    stream(request, signal) {
      configured ??= createConfiguredTransportWithFallback(selection, options.fallbackSelection,
        options.reasoningEffort, undefined, options.fastMode, { maxRetries: options.maxRetries });
      return configured.stream(request, signal);
    },
  };
  const transport = options.budget
    ? options.budget.wrap(raw, request => resolveBillingRoute(selection, request.model),
      options.workspace ? { workspace: options.workspace } : undefined)
    : raw;
  return { transport, model: selection.model.id, route: resolveBillingRoute(selection, selection.model.id),
    maxOutputTokens: selection.model.maxTokens, contextWindowTokens: selection.model.contextWindow };
}
