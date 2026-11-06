export type DiffRow = { kind: "context" | "added" | "removed"; text: string; oldLine?: number; newLine?: number };

// Bound quadratic work for large replacements; fallback is still an exact patch.
export function buildLineDiff(before: string, after: string): DiffRow[] {
  const oldLines = before === "" ? [] : before.split("\n");
  const newLines = after === "" ? [] : after.split("\n");
  const rows: DiffRow[] = [];
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    rows.push({ kind: "context", text: oldLines[prefix]!, oldLine: prefix + 1, newLine: prefix + 1 }); prefix++;
  }
  let oldEnd = oldLines.length, newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const m = oldEnd - prefix, n = newEnd - prefix;
  let i = prefix, j = prefix;
  if (m > 0 && n > 0 && m * n <= 200_000) {
    const table = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let a = m - 1; a >= 0; a--) for (let b = n - 1; b >= 0; b--) {
      table[a]![b] = oldLines[prefix + a] === newLines[prefix + b] ? table[a + 1]![b + 1]! + 1 : Math.max(table[a + 1]![b]!, table[a]![b + 1]!);
    }
    while (i < oldEnd || j < newEnd) {
      if (i < oldEnd && j < newEnd && oldLines[i] === newLines[j]) {
        rows.push({ kind: "context", text: oldLines[i]!, oldLine: ++i, newLine: ++j });
      } else if (i < oldEnd && (j === newEnd || table[i - prefix + 1]![j - prefix]! >= table[i - prefix]![j - prefix + 1]!)) {
        rows.push({ kind: "removed", text: oldLines[i]!, oldLine: ++i });
      } else rows.push({ kind: "added", text: newLines[j]!, newLine: ++j });
    }
  } else {
    while (i < oldEnd) rows.push({ kind: "removed", text: oldLines[i]!, oldLine: ++i });
    while (j < newEnd) rows.push({ kind: "added", text: newLines[j]!, newLine: ++j });
  }
  while (i < oldLines.length && j < newLines.length) rows.push({ kind: "context", text: oldLines[i]!, oldLine: ++i, newLine: ++j });
  return rows;
}

export function compactDiff(rows: readonly DiffRow[], limit = 12): DiffRow[] {
  const firstChange = rows.findIndex(row => row.kind !== "context");
  const start = Math.max(0, firstChange - 2);
  return rows.slice(start, start + limit);
}
