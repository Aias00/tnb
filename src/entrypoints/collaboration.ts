import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadCollaborationConfig } from "../services/collaboration/config";
import { loadSettings } from "../services/settings/load";
import { runtimeRequest } from "../services/runtime/server";
import { runRuntimeCommand } from "./runtime";

const HELP = `Usage: tnb collaboration <validate|start|serve|restart|stop|status|events|tickets|outbox|retry|resolve|reconcile|outbox-resolve> [options]

Uses collaboration.json in --config-dir PATH (or TNB_HOME / ~/.tnb).
validate  Check Source identities, permissions and budgets without connecting channels.
start|serve|restart|stop  Manage the SAME persistent runtime owner.
status|events|tickets|outbox [--after ID]  Read status or a page of 256 records.
retry EVENT-ID --revision N  Retry blocked work with its SAME original contract and command ID.
resolve EVENT-ID --ticket TICKET-ID --revision N  Resolve an ambiguous original thread.
reconcile NOTIFICATION-ID  Read GitHub for an exact matching author/body/marker receipt.
outbox-resolve NOTIFICATION-ID --revision N --decision sent|retry --evidence TEXT
  Explicitly confirm delivery or authorize another send after checking remote evidence.

New work: /tnb run <objective>. Followups/questions/controls refer to a ticket ID.
Source credentials are environment references. Changes take effect on restart.
No boot service registration, automatic PR creation or automatic merge is installed.
`;
export async function runCollaborationCommand(options: Parameters<typeof runRuntimeCommand>[0]): Promise<number> {
  const args = options.argv.slice(1), action = args[0];
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  if (!action || args.includes("--help") || args.includes("-h")) { options.stdout.write(HELP); return 0; }
  const configDir = resolve(value("--config-dir") ?? options.env.TNB_HOME ?? join(homedir(), ".tnb"));
  try {
    if (["validate", "start", "serve", "restart"].includes(action)) {
      const config = await loadCollaborationConfig(configDir);
      if (!config.enabled) throw new Error("Enable collaboration.json before starting collaboration mode");
      if (action !== "validate" && (await loadSettings({ configDir, cwd: configDir })).enabledPlugins?.["tnb-collaboration"] === false) throw new Error("Collaboration plugin is disabled; enable tnb-collaboration and restart the runtime");
      if (action === "validate") { options.stdout.write(`${JSON.stringify({ valid: true, sources: config.sources.map(source => ({ id: source.id, type: source.type })) }, null, 2)}\n`); return 0; }
    }
    if (["start", "serve", "restart", "stop"].includes(action)) return runRuntimeCommand({ ...options, argv: ["runtime", ...args] });
    let result: unknown;
    if (["status", "events", "tickets", "outbox"].includes(action)) result = await runtimeRequest(configDir, `/collaboration?${new URLSearchParams({ kind: action, after: value("--after") ?? "" })}`);
    else if (["retry", "resolve", "reconcile", "outbox-resolve"].includes(action)) {
      if (!args[1] || args[1].startsWith("--")) throw new Error("A record ID is required");
      result = await runtimeRequest(configDir, "/collaboration", { action, id: args[1], ticketId: value("--ticket"), revision: Number(value("--revision")), decision: value("--decision"), evidence: value("--evidence") });
    } else throw new Error("Unknown collaboration command; use --help");
    options.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return 0;
  } catch (error) { options.stderr.write(`tnb collaboration: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}
