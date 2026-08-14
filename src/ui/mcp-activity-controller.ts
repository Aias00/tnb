import type { McpCancelledEvent, McpProgressEvent } from "../services/mcp/activity";

type Listener = () => void;

export type McpActivity =
  | ({ type: "progress" } & McpProgressEvent)
  | ({ type: "cancelled" } & McpCancelledEvent);

export class McpActivityController {
  private activity: McpActivity | undefined;
  private readonly listeners = new Set<Listener>();

  current = (): McpActivity | undefined => this.activity;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  progress(event: McpProgressEvent): void {
    this.activity = { type: "progress", ...event };
    this.emit();
  }

  cancelled(event: McpCancelledEvent): void {
    this.activity = { type: "cancelled", ...event };
    this.emit();
  }

  clear(): void {
    if (!this.activity) return;
    this.activity = undefined;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
