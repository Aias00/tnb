import wrapAnsi from "wrap-ansi";
import stripAnsi from "strip-ansi";

type PluginSummary = { name: string; version: string | null; source: string; enabled: boolean; trust: string; policy?: { status: string }; description: string };

export function formatPluginList(rows: readonly PluginSummary[], columns = 80): string {
  const width = Math.max(20, Math.floor(columns));
  const lines: string[] = [];
  const safe = (value: string) => stripAnsi(value).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  for (const [source, title] of [["builtin", "Built-in plugins"], ["installed", "Installed plugins"]] as const) {
    const group = rows.filter(row => source === "builtin" ? row.source === "builtin" : row.source !== "builtin");
    if (!group.length) continue;
    lines.push(`${title} (${group.length})`, "");
    for (const plugin of group) {
      const state = plugin.enabled ? "enabled" : "disabled";
      const warning = plugin.policy && !["ready", "disabled"].includes(plugin.policy.status) ? ` · ${plugin.policy.status}`
        : ["untrusted", "changed"].includes(plugin.trust) ? ` · ${plugin.trust}` : "";
      const heading = `${safe(plugin.name)}  ${safe(plugin.version ?? "unversioned")} · ${state}${warning}`;
      lines.push(...wrapAnsi(heading, width - 2, { hard: true, trim: true }).split("\n").map(line => `  ${line}`));
      lines.push(...wrapAnsi(safe(plugin.description), width - 4, { hard: true, trim: true }).split("\n").map(line => `    ${line}`), "");
    }
  }
  if (!rows.some(row => row.source !== "builtin")) lines.push("No additional plugins installed.");
  lines.push("", ...wrapAnsi("Enabled/disabled reflects configuration, not running state.", width, { hard: true }).split("\n"), "Running plugins: tnb runtime plugins", "Details: tnb plugins show <name> · JSON: tnb plugins list --json");
  return lines.flatMap(line => wrapAnsi(line, width, { hard: true, trim: false }).split("\n")).join("\n") + "\n";
}
