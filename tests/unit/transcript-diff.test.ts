import { expect, test } from "bun:test";
import { buildLineDiff, compactDiff } from "../../src/ui/transcript/diff";

test("line diff retains shared context and numbers inserted/deleted lines", () => {
  const rows = buildLineDiff("a\nb\nc", "a\ninserted\nb\nc");
  expect(rows.map(row => row.kind)).toEqual(["context", "added", "context", "context"]);
  expect(rows[1]).toEqual({ kind: "added", text: "inserted", newLine: 2 });
  expect(rows[2]).toEqual({ kind: "context", text: "b", oldLine: 2, newLine: 3 });
});

test("diff replays exactly even for empty inputs and large bounded fallbacks", () => {
  for (const [before, after] of [["", ""], ["", "hello"], ["hello", ""], ["a\nb\nc", "a\nz\nc"], ["a\n".repeat(500), "b\n".repeat(500)]]) {
    const rows = buildLineDiff(before!, after!);
    expect(rows.filter(row => row.kind !== "added").map(row => row.text).join("\n")).toBe(before!);
    expect(rows.filter(row => row.kind !== "removed").map(row => row.text).join("\n")).toBe(after!);
  }
});

test("compact preview starts near the change rather than hiding it after long context", () => {
  const prefix = Array.from({ length: 100 }, (_, i) => `same ${i}`).join("\n");
  const shown = compactDiff(buildLineDiff(`${prefix}\nold`, `${prefix}\nnew`));
  expect(shown.some(row => row.kind === "added" && row.text === "new")).toBe(true);
  expect(shown.length).toBeLessThanOrEqual(12);
});
