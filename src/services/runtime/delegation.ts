import { text, integer } from "./json";
import type { RuntimeStore } from "./store";
import type { Operation } from "./journal";

export type DelegationProposal = { key: string; prompt: string; workspace?: string; reason?: string;
  scope?: string[]; evidenceRefs?: string[]; deliverable?: string; acceptance?: string; required?: boolean; maxTurns?: number; maxRequests?: number };

export function validateProposal(value: DelegationProposal, strict: boolean): void {
  text(value.key, "delegation key", 128); text(value.prompt, "delegation prompt");
  if (value.workspace !== undefined) text(value.workspace, "delegation workspace", 4096);
  if (!strict) return;
  text(value.reason!, "independence reason", 1000); text(value.deliverable!, "expected deliverable", 2000); text(value.acceptance!, "acceptance criteria", 2000);
  if (!Array.isArray(value.scope) || !value.scope.length || value.scope.length > 8) throw new Error("Proposal needs one to eight scope paths");
  value.scope.forEach((path) => text(path, "scope path", 4096));
  if (!Array.isArray(value.evidenceRefs) || !value.evidenceRefs.length || value.evidenceRefs.length > 8) throw new Error("Proposal needs evidenceRefs: input or tool:<call-id>");
  value.evidenceRefs.forEach((ref) => text(ref, "evidence reference", 256));
  if (typeof value.required !== "boolean") throw new Error("Proposal must declare required or auxiliary");
  integer(value.maxTurns!, "child turn limit", 1, 50); integer(value.maxRequests!, "child request limit", 1, 32);
}
export function verifyEvidence(store: RuntimeStore, runId: string, taskId: string, refs: string[]): void {
  const operations = store.records<Operation>("operation", runId, taskId);
  for (const ref of refs) {
    if (ref === "input") continue;
    if (!ref.startsWith("tool:") || !operations.some((record) => record.value.call.id === ref.slice(5) && record.value.state === "settled"
      && record.value.outcome?.result.isError === false)) throw new Error(`Unverified evidence reference: ${ref}`);
  }
}
export function parseEvidenceReport(report: string): { summary: string; evidenceRefs: string[]; uncertainties: string[] } {
  let result: { summary: string; evidenceRefs: string[]; uncertainties: string[] };
  try { result = JSON.parse(report.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")); } catch { throw new Error("Child report must be JSON: summary, evidenceRefs, uncertainties"); }
  text(result.summary, "child summary", 16000);
  if (!Array.isArray(result.evidenceRefs) || !result.evidenceRefs.length || result.evidenceRefs.length > 16) throw new Error("Child report needs bounded evidenceRefs");
  result.evidenceRefs.forEach((ref) => text(ref, "child evidence reference", 256));
  if (!Array.isArray(result.uncertainties) || result.uncertainties.length > 16) throw new Error("Child report needs uncertainties");
  result.uncertainties.forEach((item) => text(item, "uncertainty", 1000));
  return result;
}
