import { expect, test } from "bun:test";
import { formatPluginList } from "../../src/services/cli/plugin-list";
import { stringWidth } from "../../src/ui/ink/stringWidth";

test("plugin summaries remain readable without tabs on narrow and wide terminals", () => {
  for (const width of [32, 80, 140]) {
    const output = formatPluginList([
      { name: "tnb-coding", version: "0.1.0", source: "builtin", enabled: true, trust: "host-provided", description: "Controls durable Coding tasks, not ordinary terminal conversation tools." },
      { name: "example", version: "1.0.0", source: "user", enabled: true, trust: "untrusted", policy: { status: "untrusted" }, description: "中文插件说明 and a long description." },
    ], width);
    expect(output).toContain("Built-in plugins (1)");
    expect(output).toContain("Installed plugins (1)");
    expect(output).toContain("untrusted");
    expect(output).not.toContain("\t");
    for (const line of output.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(width);
  }
});
