import type { ModelEvent, ModelRequest, ModelTransport } from "./types";
import { isRetryableProviderError } from "./retry";

export function createFallbackTransport(options: {
  primary: ModelTransport;
  fallback: ModelTransport;
  fallbackModel: string;
  onFallback?(): void;
}): ModelTransport {
  let fallbackActive = false;

  return {
    async *stream(request: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelEvent> {
      if (fallbackActive) {
        yield* options.fallback.stream({ ...request, model: options.fallbackModel }, signal);
        return;
      }

      let emitted = false;
      try {
        for await (const event of options.primary.stream(request, signal)) {
          emitted = true;
          yield event;
        }
      } catch (error) {
        if (emitted || !isRetryableProviderError(error)) throw error;
        fallbackActive = true;
        options.onFallback?.();
        yield* options.fallback.stream({ ...request, model: options.fallbackModel }, signal);
      }
    },
  };
}
