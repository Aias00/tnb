import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("six actual foreground CLI processes with different TNB_HOME and provider aliases share one four-request domain", async () => {
  const root = await mkdtemp(join(tmpdir(), "tnb-cli-coordination-"));
  const held = Promise.withResolvers<void>(); let active = 0, peak = 0, requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    requests++; active++; peak = Math.max(peak, active);
    try {
      await held.promise;
      const text = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "COORDINATED" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
      return new Response(text, { headers: { "content-type": "text/event-stream" } });
    } finally { active--; }
  } });
  const children: Array<Bun.Subprocess<"ignore", "pipe", "pipe">> = [];
  try {
    for (let index = 0; index < 6; index++) {
      const config = join(root, `config-${index}`), workspace = join(root, `project-${index}`), provider = `alias-${index}`;
      await mkdir(config); await mkdir(workspace);
      const headers = index % 2 ? { "x-fixture-b": "2", "x-fixture-a": "1" } : { "x-fixture-a": "1", "x-fixture-b": "2" };
      await writeFile(join(config, "models.json"), JSON.stringify({ providers: { [provider]: { api: "openai-completions", baseUrl: `${server.url}v1${index % 2 ? "/" : ""}`, apiKey: "fixture",
        headers, models: [{ id: "fixture", contextWindow: 32000, maxTokens: 128 }] } } }));
      children.push(Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/entrypoints/cli.ts"), "--print", "Reply COORDINATED", "--provider", provider, "--model", "fixture", "--tools", "read"],
        { cwd: workspace, env: { ...process.env, TNB_HOME: config }, stdout: "pipe", stderr: "pipe" }));
    }
    const end = Date.now() + 12000;
    while (requests < 4) { if (Date.now() > end) throw new Error(`Only ${requests} CLI requests arrived`); await Bun.sleep(20); }
    await Bun.sleep(300);
    expect(requests).toBe(4); expect(peak).toBe(4);
    held.resolve();
    const results = await Promise.all(children.map(async (child) => {
      const output = new Response(child.stdout!).text(), errors = new Response(child.stderr!).text();
      return { code: await child.exited, output: await output, errors: await errors };
    }));
    for (const result of results) { expect(result.code).toBe(0); expect(result.output).toContain("COORDINATED"); }
    expect(requests).toBe(6); expect(peak).toBeLessThanOrEqual(4);
  } finally {
    held.resolve();
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all(children.map((child) => child.exited)); await server.stop(true); await rm(root, { recursive: true, force: true });
  }
}, 20000);
