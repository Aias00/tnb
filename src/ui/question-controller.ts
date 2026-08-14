import type { UserQuestion } from "../tools/interaction";

type Listener = () => void;

export class QuestionController {
  private pending: {
    question: UserQuestion;
    resolve(answer: string): void;
    reject(error: Error): void;
    removeAbortListener?: () => void;
  } | undefined;
  private readonly listeners = new Set<Listener>();

  current = (): UserQuestion | undefined => this.pending?.question;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  request = (question: UserQuestion, signal?: AbortSignal): Promise<string> => {
    if (this.pending) return Promise.reject(new Error("A user question is already pending"));
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const pending: NonNullable<QuestionController["pending"]> = { question, resolve, reject };
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

  resolve(answer: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.removeAbortListener?.();
    pending.resolve(answer);
    this.emit();
  }

  reject(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.removeAbortListener?.();
    pending.reject(error);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
