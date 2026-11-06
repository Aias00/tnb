import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import packageJson from "../package.json";

export async function buildPluginSdk(root: string, destination: string): Promise<string> {
  root = resolve(root); destination = resolve(destination);
  const generator = join(root, "tools/plugin-sdk-build/node_modules/dts-bundle-generator/dist/bin/dts-bundle-generator.js");
  if (!await Bun.file(generator).exists()) throw new Error("SDK declaration tools are missing; run bun run sdk:setup first");
  await mkdir(destination, { recursive: true });
  const stage = await mkdtemp(join(destination, ".sdk-stage-"));
  try {
    const pkg = join(stage, "package"); await mkdir(pkg);
    for (const name of ["index", "testing"]) {
      const built = await Bun.build({ entrypoints: [join(root, `src/plugin-sdk/${name}.ts`)], target: "bun", format: "esm", outdir: pkg, naming: `${name}.js` });
      if (!built.success) throw new AggregateError(built.logs, "Plugin SDK runtime build failed");
    }
    const config = join(stage, "declarations.json");
    await writeFile(config, JSON.stringify({ compilationOptions: { preferredConfigPath: join(root, "tools/plugin-sdk-build/tsconfig.json") }, entries: ["index", "testing"].map(name => ({
      filePath: join(root, `src/plugin-sdk/${name}.ts`), outFile: join(pkg, `${name}.d.ts`),
      output: { noBanner: true, exportReferencedTypes: false }, libraries: { importedLibraries: [], allowedTypesLibraries: [] },
    })) }));
    const declaration = Bun.spawn([process.execPath, generator, "--config", config], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(declaration.stdout).text(), new Response(declaration.stderr).text(), declaration.exited]);
    if (code) throw new Error(`Plugin SDK declaration generation failed\n${stdout}\n${stderr}`);
    const types = (await Promise.all(["index", "testing"].map(name => readFile(join(pkg, `${name}.d.ts`), "utf8")))).join("\n");
    if (/^import\s|\/\/\/\s*<reference|import\(["']|\b(?:Bun|RuntimeStore|DurableRuntime)\b/m.test(types)) throw new Error("Plugin SDK declarations must not depend on host internals or external type packages");
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@tnb/plugin-sdk", version: packageJson.version, description: "TNB plugin author contracts and helpers", type: "module", license: "Apache-2.0",
      exports: { ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" }, "./testing": { types: "./testing.d.ts", import: "./testing.js", default: "./testing.js" } }, types: "./index.d.ts", main: "./index.js",
      files: ["index.js", "index.d.ts", "testing.js", "testing.d.ts", "README.md", "LICENSE"], repository: { type: "git", url: "https://github.com/Aias00/tnb.git" } }, null, 2) + "\n");
    await cp(join(root, "LICENSE"), join(pkg, "LICENSE"));
    await writeFile(join(pkg, "README.md"), "# TNB plugin SDK\n\nInstall this local package or its companion tarball as a development dependency. The main entry has no third-party runtime dependencies and does not start a host. Explicitly import @tnb/plugin-sdk/testing for a Bun-only temporary test host; never bundle testing into production plugin entries.\n\n```ts\nimport { definePlugin, defineAgent, defineTool, createServiceRef } from '@tnb/plugin-sdk';\n```\n\nTypes are generated from the TNB host contracts. Compile plugin source and dependencies into a bundled .mjs entry before installing it into TNB. Keep manifestVersion 2 and apiVersion tnb.host-plugin/v1 in plugin.json. SDK package version follows the distributing host; the manifest API version remains the compatibility authority.\n\nSee https://github.com/Aias00/tnb/blob/main/docs/guides/plugin-sdk.md for development, packaging, and verification. This package has not been published to a registry by the build step.\n");
    const packed = Bun.spawn([process.execPath, "pm", "pack", "--destination", stage], { cwd: pkg, stdout: "pipe", stderr: "pipe" });
    const [packedOut, packedErr, packedCode] = await Promise.all([new Response(packed.stdout).text(), new Response(packed.stderr).text(), packed.exited]);
    if (packedCode) throw new Error(`Plugin SDK pack failed\n${packedOut}\n${packedErr}`);
    const filename = `tnb-plugin-sdk-${packageJson.version}.tgz`;
    if (!await Bun.file(join(stage, filename)).exists()) throw new Error("Plugin SDK pack produced no expected tarball");
    await rm(join(destination, "plugin-sdk"), { recursive: true, force: true });
    await rename(pkg, join(destination, "plugin-sdk"));
    await rm(join(destination, filename), { force: true }); await rename(join(stage, filename), join(destination, filename));
    return join(destination, filename);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, ".."), index = process.argv.indexOf("--outdir");
  const destination = index < 0 ? join(root, "dist") : resolve(process.argv[index + 1] ?? "");
  if (index >= 0 && !process.argv[index + 1]) throw new Error("--outdir requires a directory");
  process.stdout.write(`Plugin SDK: ${await buildPluginSdk(root, destination)}\n`);
}
