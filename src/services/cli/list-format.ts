import wrapAnsi from "wrap-ansi";
import stripAnsi from "strip-ansi";

export type ListSummary = { title: string; details?: readonly string[] };
export function outputColumns(writer: { write(text: string): unknown; columns?: number }): number {
  const value = writer.columns ?? process.stdout.columns ?? 80;
  return Number.isFinite(value) ? Math.max(20, Math.floor(value)) : 80;
}
export function formatSummaryList(title: string, items: readonly ListSummary[], columns = 80, empty = "No items found."): string {
  const width = Number.isFinite(columns) ? Math.max(20, Math.floor(columns)) : 80;
  const clean = (value: string) => stripAnsi(value).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  const line = (text: string, indent: number) => wrapAnsi(clean(text), width - indent, { hard: true, trim: true }).split("\n").map(part => " ".repeat(indent) + part);
  const lines = [...line(`${title} (${items.length})`, 0), ""];
  if (!items.length) lines.push(...line(empty, 0));
  for (const item of items) {
    lines.push(...line(item.title, 2));
    for (const detail of item.details ?? []) if (detail) lines.push(...line(detail, 4));
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
