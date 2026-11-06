import { processPluginTemplate } from "./process-template";
import { pluginTemplate, type PluginTemplate } from "./templates";

/** The distributable runtime is built from src/index.ts into package/index.mjs. */
export function typescriptPluginTemplate(name: string, template: PluginTemplate, sdkTarball: string, execution: "in-process" | "process" = "in-process"): Record<string, string> {
  const files = execution === "process" ? processPluginTemplate(name, template) : pluginTemplate(name, template), manifest = JSON.parse(files["plugin.json"]!);
  for (const declarations of Object.values(manifest.contributes) as Array<Array<{ entry: string }>>) for (const row of declarations) row.entry = "index.mjs";
  let source = files["index.mjs"]!.replace("export default api =>", "const setup: HostPluginFactory = api =>");
  const imports = `import { definePlugin, type HostPluginFactory${template === "agent" ? ", defineAgent, type JsonValue, type WorkerResources" : template === "channel" ? ", type JsonValue" : ""} } from "@tnb/plugin-sdk";\n\n`;
  if (template === "agent") {
    source = source.replace('    if (!config || typeof config.message !== "string" || !config.message.trim()) throw new Error("config.message is required");', '    readText(config, "message");')
      .replaceAll("context.descriptor.config.message", 'readText(context.descriptor.config, "message")')
      .replace("async createWorker(context) {", "async createWorker(context): Promise<WorkerResources> {")
      .replace("api.registerAdapter({", "api.registerAdapter(defineAgent({")
      .replace('version: "1",\n  validate', 'version: "1",\n  configuration: { type: "object", properties: { message: { type: "string", minLength: 1 } }, required: ["message"], additionalProperties: false },\n  validate')
      .replace(/\}\);\s*$/, "}));\n");
  } else if (template === "application") {
    source = source.replace('tx.get("visits")', 'tx.get<number>("visits")!').replaceAll('context.state.get("visits")', 'context.state.get<number>("visits")!');
  } else {
    source = source.replace('  if (typeof configuration.text !== "string") throw new Error("configuration.text is required");', '  const text = readText(configuration, "text");')
      .replace("text: configuration.text", "text")
      .replace("context.state.get(message.id)", "context.state.get<{ receipt: string }>(message.id)");
  }
  const helper = template === "application" ? "" : `function readText(value: JsonValue, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object configuration");
  const text = value[key];
  if (typeof text !== "string" || !text.trim()) throw new Error(key + " is required");
  return text;
}\n\n`;
  const processSource = execution === "process" ? `import { defineProcessPlugin, type ProcessPluginDefinition, type JsonValue } from "@tnb/plugin-sdk";\n${helper}\n` + files["index.mjs"]!.replace("export default {", "const definition: ProcessPluginDefinition = {")
    .replace('  const configuration = context.configuration;', '  const configuration = { text: readText(context.configuration, "text") };')
    .replace('context.state.get(message.id)', 'context.state.get<{ receipt: string }>(message.id)') + "\nexport default defineProcessPlugin(definition);\n" : undefined;
  const test = files["plugin.test.json"]!;
  return {
    "src/index.ts": processSource ?? imports + helper + source + "\nexport default definePlugin(setup);\n",
    "plugin.json": JSON.stringify(manifest, null, 2) + "\n",
    "plugin.test.json": test,
    ...(files["task.json"] ? { "task.json": files["task.json"] } : {}),
    "package.json": JSON.stringify({ name: `${name}-development`, private: true, type: "module", scripts: {
      typecheck: "tsc --noEmit", build: "bun scripts/build.ts", validate: "tnb plugins validate package", test: "tnb plugins test package --yes",
      check: "bun run typecheck && bun run build && bun run validate && bun run test",
    }, devDependencies: { "@tnb/plugin-sdk": `file:${sdkTarball}`, typescript: "7.0.2" } }, null, 2) + "\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", lib: ["ESNext", "DOM", "DOM.Iterable"], strict: true, noUncheckedIndexedAccess: true, noEmit: true, types: [], skipLibCheck: false }, include: ["src"] }, null, 2) + "\n",
    "scripts/build.ts": `import { mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dir, ".."), out = join(root, "package");
// A failed build must not leave an old package that looks ready to install.
await rm(out, { recursive: true, force: true });
const stage = await mkdtemp(join(root, ".plugin-build-"));
try {
  const built = await Bun.build({ entrypoints: [join(root, "src/index.ts")], target: "bun", format: "esm", outdir: stage, naming: "index.mjs", packages: "bundle" });
  if (!built.success) throw new AggregateError(built.logs, "Plugin build failed");
  for (const name of ${JSON.stringify(["plugin.test.json", "plugin.json", ...(template === "agent" ? ["task.json"] : [])])}) await writeFile(join(stage, name), await readFile(join(root, name)));
  await rename(stage, out); console.log("Built installable package/");
} finally { await rm(stage, { recursive: true, force: true }); }
`,
    ".gitignore": "node_modules/\npackage/\n.plugin-build-*/\n",
    "README.md": `# ${name}\n\nTypeScript ${template} plugin using the standalone @tnb/plugin-sdk tarball delivered with TNB. No registry publication is assumed.\n\n\`\`\`sh\nbun install --ignore-scripts\nbun run typecheck\nbun run build\nbun run validate\nbun run test\n# Or: bun run check\n\`\`\`\n\nKeep tnb on PATH. Edit src/index.ts and plugin.test.json; type checking includes full SDK declarations without skipLibCheck. The Agent transport is an offline fixture. SDK package paths are local development dependencies; use --sdk to select another tarball when creating the project, or update package.json if you move it.\n\nOnly package/ is installable. It contains bundled index.mjs, plugin.json and plugin.test.json; it does not require node_modules at runtime.\n\n\`\`\`sh\ntnb plugins install ./package\ntnb plugins trust ${name} --yes\ntnb plugins enable ${name}\ntnb runtime restart\n\`\`\`\n\nThe test command executes trusted code with temporary state, not an OS sandbox. Real model credentials, host services and business acceptance remain explicit integrations. The Agent template also ships task.json: use tnb runtime adapters, then tnb runtime submit "Read the authorized message" --adapter ./package/task.json --namespace demo after installation. The default Coding route stays explicit.\n`,
  };
}
