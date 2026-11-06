import { resolve } from "node:path";
import { initializePlugin, validatePluginPackage, testPluginPackage } from "../plugins/development";
import { PLUGIN_TEMPLATES, type PluginTemplate } from "../plugins/templates";
import type { ManagementCommandOptions } from "./management";

export const PLUGIN_DEVELOPMENT_HELP = `Usage: tnb plugins <action> [directory|name] [options]

Plugin development:
  tnb plugins init <directory> [--template agent|application|channel] [--name NAME]
  tnb plugins validate <directory> [--json]
  tnb plugins test <directory> --yes [--json]

init creates a standalone ESM package and plugin.test.json; default template is agent.
validate reads the real manifest/entry/scenario contracts without executing plugin code.
test executes trusted plugin code in a temporary host; --yes explicitly permits execution.
Temporary host state is separate from your installed plugins, settings and running owner.
Agent template uses an offline scripted model and a real tool receipt. No API key is needed.
Tests are not a sandbox. Required host services/dependencies need a custom SDK test host.
`;

export async function runPluginDevelopmentCommand(options: ManagementCommandOptions): Promise<number> {
  const action = options.argv[1]!, args = options.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { options.stdout.write(PLUGIN_DEVELOPMENT_HELP); return 0; }
  const target = args[0];
  if (!target || target.startsWith("--")) throw new Error(`plugins ${action} requires a directory`);
  let template: PluginTemplate = "agent", name: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--json" || action === "test" && flag === "--yes") continue;
    if (action === "init" && ["--template", "--name"].includes(flag)) {
      const value = args[++index]; if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--name") name = value;
      else { if (!(PLUGIN_TEMPLATES as readonly string[]).includes(value)) throw new Error("--template must be agent, application or channel"); template = value as PluginTemplate; }
    } else throw new Error(`Unexpected plugins ${action} argument: ${flag}`);
  }
  const directory = resolve(options.cwd, target);
  if (action === "init") {
    const result = await initializePlugin(directory, template, name);
    if (args.includes("--json")) options.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else options.stdout.write(`Created ${result.name} (${result.template}) in ${result.directory}\n\nNext, from that directory:\n  tnb plugins validate .\n  tnb plugins test . --yes\n\nSee README.md and edit index.mjs plus plugin.test.json.\n`);
    return 0;
  }
  if (action === "test" && !args.includes("--yes")) throw new Error("plugins test executes trusted plugin code; add --yes after reviewing the package. For a read-only check use plugins validate");
  const result = action === "validate" ? await validatePluginPackage(directory) : await testPluginPackage(directory);
  options.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result.ok ? 0 : 1;
}
