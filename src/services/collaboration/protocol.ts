import { digestJson, integer, text } from "../runtime/json";
import type { Action } from "./types";

export const NS = { events: "collaboration.events", tickets: "collaboration.tickets", outbox: "collaboration.outbox", cursors: "collaboration.cursors" } as const;
export function eventId(sourceId: string, externalId: string): string { return digestJson({ sourceId, externalId }); }
export function ticketId(event: string): string { return `t_${event.slice(0, 32)}`; }
export function parseAction(raw: string): Action | undefined {
  const input = raw.trim();
  if (!input.startsWith("/tnb")) return input ? { kind: "followup", text: input } : undefined;
  let match = /^\/tnb run\s+([\s\S]+)$/.exec(input);
  if (match) return { kind: "run", text: text(match[1]!, "objective", 4000) };
  match = /^\/tnb followup\s+(t_[a-f0-9]{32})\s+([\s\S]+)$/.exec(input);
  if (match) return { kind: "followup", ticketId: match[1], text: match[2]! };
  match = /^\/tnb answer\s+(t_[a-f0-9]{32})\s+([a-f0-9]{64})\s+(\d+)\s+([\s\S]+)$/.exec(input);
  if (match) return { kind: "answer", ticketId: match[1]!, waitId: match[2]!, version: integer(Number(match[3]), "question version", 1), text: match[4]! };
  match = /^\/tnb (pause|resume|cancel)\s+(t_[a-f0-9]{32})$/.exec(input);
  if (match) return { kind: match[1] as "pause" | "resume" | "cancel", ticketId: match[2]! };
  match = /^\/tnb bind\s+(t_[a-f0-9]{32})\s+(\d+)$/.exec(input);
  if (match) return { kind: "bind", ticketId: match[1]!, number: integer(Number(match[2]), "PR number", 1) };
  throw new Error("Unknown /tnb command; use run, followup, answer, pause, resume, cancel or bind");
}
