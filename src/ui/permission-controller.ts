import type { PermissionAskRequest, PermissionPromptDecision } from "../core/permissions";

type Listener = () => void;

export class PermissionController {
  private pending: {
    request: PermissionAskRequest;
    resolve(decision: PermissionPromptDecision): void;
    reject(error: Error): void;
    removeAbortListener?: () => void;
  } | undefined;
  private readonly listeners = new Set<Listener>();

  current = (): PermissionAskRequest | undefined => this.pending?.request;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  request = (request: PermissionAskRequest, signal?: AbortSignal): Promise<PermissionPromptDecision> => {
    if (this.pending) {
      return Promise.reject(new Error("A permission request is already pending"));
    }
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const pending: NonNullable<PermissionController["pending"]> = { request, resolve, reject };
      if (signal) {
        const abort = () => {
          if (this.pending !== pending) return;
          this.pending = undefined;
          reject(signal.reason instanceof Error
            ? signal.reason
            : new DOMException("Aborted", "AbortError"));
          this.emit();
        };
        signal.addEventListener("abort", abort, { once: true });
        pending.removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      this.pending = pending;
      this.emit();
    });
  };

  resolve(decision: PermissionPromptDecision): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.removeAbortListener?.();
    pending.resolve(decision);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
