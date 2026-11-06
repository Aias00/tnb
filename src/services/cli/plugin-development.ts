import { resolve } from "node:path";
import { initializePlugin, validatePluginPackage, testPluginPackage } from "../plugins/development";
import { PLUGIN_TEMPLATES, type PluginTemplate } from "../plugins/templates";
import type { ManagementCommandOptions } from "./management";

export const PLUGIN_DEVELOPMENT_HELP = `Usage: tnb plugins <action> [directory|name] [options]

Plugin development:
  tnb plugins init <directory> [--template agent|application|channel] [--name NAME]
    [--language javascript|typescript] [--sdk /path/to/sdk.tgz] [--execution in-process|process]
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
  let template: PluginTemplate = "agent", name: string | undefined, language: "javascript" | "typescript" = "javascript", sdkTarball: string | undefined, execution: "in-process" | "process" = "in-process";
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--json" || action === "test" && flag === "--yes") continue;
    if (action === "init" && ["--template", "--name", "--language", "--sdk", "--execution"].includes(flag)) {
      const value = args[++index]; if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--execution") { if (value !== "in-process" && value !== "process") throw new Error("--execution must be in-process or process"); execution = value; }
      else if (flag === "--name") name = value;
      else if (flag === "--sdk") sdkTarball = resolve(options.cwd, value);
      else if (flag === "--language") { if (value !== "javascript" && value !== "typescript") throw new Error("--language must be javascript or typescript"); language = value; }
      else { if (!(PLUGIN_TEMPLATES as readonly string[]).includes(value)) throw new Error("--template must be agent, application or channel"); template = value as PluginTemplate; }
    } else throw new Error(`Unexpected plugins ${action} argument: ${flag}`);
  }
  const directory = resolve(options.cwd, target);
  if (action === "init") {
    if (sdkTarball && language !== "typescript") throw new Error("--sdk requires --language typescript");
    const result = await initializePlugin(directory, template, name, { language, sdkTarball, execution });
    if (args.includes("--json")) options.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else options.stdout.write(`Created ${result.name} (${result.template}, ${result.language}) in ${result.directory}\n\nNext, from that directory:\n${language === "typescript" ? "  bun install --ignore-scripts\n  bun run check" : "  tnb plugins validate .\n  tnb plugins test . --yes"}\n\nSee README.md and edit ${language === "typescript" ? "src/index.ts" : "index.mjs"} plus plugin.test.json.\n`);
    return 0;
  }
  if (action === "test" && !args.includes("--yes")) throw new Error("plugins test executes trusted plugin code; add --yes after reviewing the package. For a read-only check use plugins validate");
  const result = action === "validate" ? await validatePluginPackage(directory) : await testPluginPackage(directory);
  options.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result.ok ? 0 : 1;
}
