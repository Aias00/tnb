import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
await rm("package", { recursive: true, force: true }); await mkdir("package");
const result = await Bun.build({ entrypoints: ["src/agent.ts", "src/intake.ts"], outdir: "package", target: "bun", naming: "[name].mjs" });
if (!result.success) { await rm("package", { recursive: true, force: true }); throw new AggregateError(result.logs); }
await writeFile("package/plugin.json", await readFile("plugin.json"));
