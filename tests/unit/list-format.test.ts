import { expect, test } from "bun:test";
import { formatSummaryList } from "../../src/services/cli/list-format";
import { stringWidth } from "../../src/ui/ink/stringWidth";

test("summary lists wrap long IDs, paths and CJK content while retaining labels", () => {
  for (const width of [24, 40, 80]) {
    const output = formatSummaryList("Sessions", [{ title: "检查当前工程", details: ["ID: abcdef0123456789".repeat(3), "Updated: 2026-11-05 08:00", "Long path: /projects/" + "nested/".repeat(12)] }], width);
    expect(output).toContain("Sessions (1)"); expect(output).not.toContain("\t");
    for (const line of output.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(width);
  }
});
test("empty lists print an explicit result and terminal escapes are not executed", () => {
  expect(formatSummaryList("Agents", [])).toContain("No items found.");
  expect(formatSummaryList("MCP servers", [], 80, "No MCP servers configured.")).toContain("No MCP servers configured.");
  const output = formatSummaryList("Items", [{ title: "\u001b[31mname\u001b[0m\tvalue", details: ["first\nsecond"] }]);
  expect(output).not.toContain("\u001b"); expect(output).not.toContain("\t"); expect(output).toContain("first second");
});
