import type { ChannelDescriptor, ChannelEvent, ChannelMessage } from "../../agent/extensions";
import type { RuntimeConfiguration } from "../runtime/engine-core";
import type { RunStatus } from "../runtime/types";

export type Source = {
  id: string; type: "github" | "webhook" | "timer" | "plugin"; channel?: ChannelDescriptor; options?: import("../../agent/domain").JsonValue; actors: string[]; controllers: string[];
  configuration: RuntimeConfiguration; mode: "single" | "auto" | "multi"; pollIntervalMs: number;
  github?: { repository: string; tokenEnv: string };
  webhook?: { secretEnv: string; outboundUrl: string };
  timer?: { everyMs: number; objective: string; thread: string };
};
export type CollaborationConfig = { enabled: boolean; sources: Source[]; listen?: { hostname: "127.0.0.1" | "::1"; port: number } };
export type IncomingEvent = ChannelEvent;
export type Action =
  | { kind: "run"; text: string }
  | { kind: "followup"; ticketId?: string; text: string }
  | { kind: "answer"; ticketId: string; waitId: string; version: number; text: string }
  | { kind: "pause" | "resume" | "cancel"; ticketId: string }
  | { kind: "bind"; ticketId: string; number: number };
export type IntakeEvent = {
  id: string; sourceId: string; incoming: IncomingEvent; digest: string; identity: string; receivedAt: number;
  state: "pending" | "ignored" | "rejected" | "clarify" | "processed" | "blocked";
  action?: Action; configuration?: RuntimeConfiguration; mode?: Source["mode"];
  ticketId?: string; candidates?: string[]; prepared?: { runId: string; revision: number }; error?: string;
};
export type PullRequestFacts = {
  number: number; head: string; state: "open" | "closed"; merged: boolean; url: string;
  ci: Array<{ name: string; status: string; conclusion: string | null }>;
  reviews: Array<{ actor: string; state: string; commit: string | null }>;
};
export type Ticket = {
  id: string; sourceId: string; identity: string; thread: string; actor: string; objective: string;
  eventId: string; runId: string; createdAt: number; state: "watching" | "settled"; status: RunStatus; pr?: PullRequestFacts;
  delivery: "executing" | "completed" | "awaiting-pr" | "merged" | "closed";
};
export type Notification = {
  id: string; sourceId: string; identity: string; thread: string; ticketId?: string; text: string;
  state: "pending" | "dispatched" | "sent" | "unknown" | "suppressed"; createdAt: number; sequence: number;
  question?: { runId: string; waitId: string; version: number }; receipt?: string; error?: string;
  history?: Array<{ decision: "sent" | "retry"; evidence: string; at: number }>;
};
export type SourceCursor = { value: string; lastPollAt: number };
/** Network reads may retry; writes return a verifiable external receipt or remain unknown. */
export interface SourcePort {
  receive?(request: Request, signal: AbortSignal): Promise<IncomingEvent[]>;
  poll?(cursor: string | undefined, signal: AbortSignal): Promise<{ events: IncomingEvent[]; cursor: string }>;
  send(notification: ChannelMessage, signal: AbortSignal): Promise<string>;
  find?(notification: ChannelMessage, signal: AbortSignal): Promise<string | undefined>;
  inspectPR?(number: number, signal: AbortSignal): Promise<PullRequestFacts>;
}
