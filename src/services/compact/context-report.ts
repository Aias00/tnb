import { withoutFileChangeEvidence } from "../../core/message";
import type { ConversationMessage } from "../../core/message";
import type { ModelRequest } from "../../providers/types";

export type ContextReport = { source: "request" | "history"; capturedAt: string; model?: string; contextWindow: number;
  categories: { name: string; tokens: number }[]; estimatedInput: number; outputReserve?: number; mediaBlocks: number };
const tokens = (value: unknown) => value === undefined ? 0 : Math.ceil(JSON.stringify(value).length / 4);

/** Textual serialization estimates only; media tokenization is Provider-specific. */
export function contextReport(options: { messages: ConversationMessage[]; contextWindow: number; request?: ModelRequest; maxOutputTokens?: number }): ContextReport {
  const request = options.request;
  const values = new Map<string, number>();
  let mediaBlocks = 0;
  const add = (name: string, value: unknown) => values.set(name, (values.get(name) ?? 0) + tokens(value));
  if (request) { add("System instructions", request.systemPrompt); add("Tool definitions", request.tools); }
  for (const message of withoutFileChangeEvidence(request?.messages ?? options.messages)) {
    add("Message framing", { role: message.role });
    for (const block of message.content) {
      if (block.type === "image" || block.type === "document") { mediaBlocks++; continue; }
      if (block.type === "tool-result") add("Tool results", block);
      else if (block.type === "tool-use") add("Tool calls", block);
      else if (block.type === "thinking") add("Reasoning replay", block);
      else if (block.type === "text" && /(?:compacted|conversation summary|summary of (?:the )?(?:previous|prior)|<summary>)/i.test(block.text.slice(0, 250))) add("Summary-like text (heuristic)", block);
      else add("Conversation text", block);
    }
  }
  const categories = [...values].filter(([, count]) => count > 0).map(([name, count]) => ({ name, tokens: count }));
  return { source: request ? "request" : "history", capturedAt: new Date().toISOString(), ...(request ? { model: request.model } : {}),
    contextWindow: options.contextWindow, categories, estimatedInput: categories.reduce((sum, category) => sum + category.tokens, 0),
    ...(request ? { outputReserve: request.maxOutputTokens ?? options.maxOutputTokens } : {}), mediaBlocks };
}

export function formatContextReport(report: ContextReport): string {
  return [report.source === "request" ? "Context breakdown · last prepared execution request" : "Context breakdown · saved history only",
    ...(report.model ? [`Requested model: ${report.model}`] : []), `Model context: ${report.contextWindow.toLocaleString()} tokens`, "",
    ...report.categories.map(category => `${category.name}: ~${category.tokens.toLocaleString()} tokens`),
    "", `Estimated text input: ~${report.estimatedInput.toLocaleString()} tokens`,
    ...(report.outputReserve !== undefined ? [`Output reserve: ${report.outputReserve.toLocaleString()} tokens`] : ["Output reserve: unavailable"]),
    ...(report.mediaBlocks ? [`Media attachments: ${report.mediaBlocks} · token cost not included`] : []),
    ...(report.source === "history" ? ["System instructions and tool definitions unavailable until the next model request."] : [`Snapshot: ${report.capturedAt} · follow-up messages may differ.`]),
    "Estimates use serialized text length, not the Provider tokenizer. Provider-reported input is shown separately in the status bar.",
  ].join("\n");
}
