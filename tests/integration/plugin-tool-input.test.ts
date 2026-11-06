import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPlugins, type ExternalPluginToolContribution } from "../../src/services/plugins/loader";
import { createExternalPluginTools, PluginToolRuntimeManager } from "../../src/services/plugins/tools";
import { compilePluginToolInputSchema } from "../../src/services/plugins/tool-input";
import { executeTool } from "../../src/core/tool-runtime";
import type { AgentLoopOptions } from "../../src/core/agent-loop";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
const schema = { type: "object", description: "Bounded tool input", properties: {
  label: { type: "string", description: "Human label", minLength: 1, maxLength: 8 },
  count: { type: "integer", minimum: 0, maximum: 3 },
  flags: { type: "array", maxItems: 2, items: { type: "string", enum: ["a", "b"] } },
}, required: ["label", "count"], additionalProperties: false };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tnb-tool-input-")); cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const pack = join(root, "pack"); await mkdir(pack); await writeFile(join(pack, "plugin.json"), JSON.stringify({ name: "input-pack" }));
  const plugin = (await loadPlugins([{ directory: root, source: "user" }])).plugins[0]!;
  const received: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { params: { input: unknown } }; received.push(body.params.input); return Response.json({ result: "accepted" });
  } }); cleanup.push(() => server.stop(true));
  const contribution: ExternalPluginToolContribution = { id: "input", type: "external", description: "Offline input test", command: server.url.href, args: [], inputSchema: structuredClone(schema),
    security: { access: "read", workspace: "none", network: "loopback", shell: false, approval: "inherit" }, lifecycle: { transport: "http", start: "lazy", reload: "runtime" } };
  const runtime = new PluginToolRuntimeManager({}, { timeoutMs: 1500, killGraceMs: 20 }); cleanup.push(() => runtime.close());
  const tools = async (row = contribution) => createExternalPluginTools([{ ...plugin, toolContributions: [row] }], {}, runtime);
  return { root, pack, plugin, received, contribution, runtime, tools };
}

test("inline schemas reject unsupported assertions at discovery and retain model descriptions", async () => {
  const f = await fixture();
  for (const inputSchema of [{ type: "object", anyOf: [] }, { type: "object", $ref: "https://example.com/private-schema" }, { type: "object", default: { label: "secret-default" } }]) {
    await writeFile(join(f.pack, "plugin.json"), JSON.stringify({ name: "input-pack", contributes: { tools: [{ ...f.contribution, inputSchema }] } }));
    const result = await loadPlugins([{ directory: f.root, source: "user" }]);
    expect(result.plugins).toEqual([]); expect(result.errors[0]?.error).toContain("PLUGIN_TOOL_SCHEMA_INVALID"); expect(result.errors[0]?.error).not.toContain("secret-default");
  }
  const tool = (await f.tools())[0]!;
  expect(tool.inputSchema).toEqual(schema); expect(f.received).toEqual([]);
});

test("HTTP validates required keys, scalar types, bounds, enums, arrays and closed properties before effects", async () => {
  const f = await fixture();
  for (const input of [{ label: "ok" }, { label: "", count: 1 }, { label: "ok", count: "1" }, { label: "ok", count: 1.5 }, { label: "ok", count: 4 },
    { label: "ok", count: 1, unknown: true }, { label: "ok", count: 1, flags: ["c"] }, { label: "ok", count: 1, flags: ["a", "a", "a"] }]) {
    await expect(f.runtime.call(f.plugin, f.contribution, input, signal())).rejects.toThrow("PLUGIN_TOOL_INPUT_INVALID");
  }
  expect(f.received).toEqual([]);
  expect(await f.runtime.call(f.plugin, f.contribution, { label: "汉字", count: 2, flags: ["a"] }, signal())).toBe("accepted");
  expect(f.received).toEqual([{ label: "汉字", count: 2, flags: ["a"] }]);
});

test("direct tool.execute cannot bypass validation or weaken it by editing the visible catalog", async () => {
  const f = await fixture(), tool = (await f.tools())[0]!;
  tool.inputSchema.required = []; tool.inputSchema.additionalProperties = true;
  f.contribution.inputSchema = { type: "object", additionalProperties: true };
  await expect(tool.execute({ privateValue: "must-not-echo" }, signal())).rejects.toThrow("PLUGIN_TOOL_INPUT_INVALID");
  expect(() => tool.validate({ label: "ok", count: "must-not-echo" })).toThrow("PLUGIN_TOOL_INPUT_INVALID");
  expect(f.received).toEqual([]);
  expect(await tool.execute({ label: "ok", count: 1 }, signal())).toBe("accepted");
});

test("Hook and authorization rewrites are revalidated before journal dispatch or external requests", async () => {
  const f = await fixture(), tool = (await f.tools())[0]!; let journalCalls = 0, authorizations = 0;
  for (const phase of ["hook", "approval"]) {
    const options = { tools: [tool],
      beforeTool: async () => phase === "hook" ? { input: { label: "ok", count: "private-invalid" } } : undefined,
      authorize: async () => { authorizations++; return { behavior: "allow", ...(phase === "approval" ? { updatedInput: { label: "ok", count: 99 } } : {}) }; },
      callJournal: { async intend() { journalCalls++; return "operation"; }, async dispatch() { journalCalls++; } },
    } as unknown as AgentLoopOptions;
    const outcome = await executeTool({ type: "tool-use", id: phase, name: tool.name, input: { label: "ok", count: 1 } }, options, signal());
    expect(outcome.result.isError).toBe(true); expect(outcome.result.content).toContain("PLUGIN_TOOL_INPUT_INVALID"); expect(outcome.result.content).not.toContain("private-invalid");
  }
  expect(authorizations).toBe(1); expect(journalCalls).toBe(0); expect(f.received).toEqual([]);
});

test("valid Hook rewrites keep authorization and actual transport on the same final input", async () => {
  const f = await fixture(), tool = (await f.tools())[0]!; let authorized: unknown;
  const outcome = await executeTool({ type: "tool-use", id: "valid", name: tool.name, input: { label: "first", count: 1 } }, {
    tools: [tool], beforeTool: async () => ({ input: { label: "changed", count: 2 } }),
    authorize: async (_tool: unknown, input: unknown) => { authorized = input; return { behavior: "allow" }; },
  } as unknown as AgentLoopOptions, signal());
  expect(outcome.result.isError).toBe(false); expect(authorized).toEqual({ label: "changed", count: 2 }); expect(f.received).toEqual([authorized]);
});

test("schema files are bounded and pinned for both model validation and actual execution", async () => {
  const f = await fixture(), path = join(f.pack, "schema.json"); await writeFile(path, JSON.stringify(schema));
  const { inputSchema: _inline, ...base } = f.contribution;
  const contribution = { ...base, inputSchemaPath: path };
  await f.runtime.startEager([{ ...f.plugin, toolContributions: [contribution] }]);
  await writeFile(path, JSON.stringify({ type: "object", additionalProperties: true }));
  const tool = (await f.tools(contribution))[0]!;
  expect(() => tool.validate({})).toThrow("PLUGIN_TOOL_INPUT_INVALID");
  await expect(tool.execute({}, signal())).rejects.toThrow("PLUGIN_TOOL_INPUT_INVALID");
  expect(await tool.execute({ label: "ok", count: 1 }, signal())).toBe("accepted");
  expect(f.received).toHaveLength(1);
});

test("invalid, oversized and non-object file schemas fail catalog creation before activation", async () => {
  const f = await fixture(), path = join(f.pack, "schema.json"), { inputSchema: _inline, ...base } = f.contribution;
  for (const contents of ["{private-invalid-json", '"private-string"', JSON.stringify({ type: "array", items: { type: "string" } }), " ".repeat(65537)]) {
    await writeFile(path, contents);
    await expect(f.tools({ ...base, inputSchemaPath: path })).rejects.toThrow("PLUGIN_TOOL_SCHEMA_INVALID");
  }
  const outside = join(f.root, "outside.json"); await writeFile(outside, JSON.stringify(schema));
  for (const inputSchemaPath of [outside, join(f.pack, "missing.json"), f.pack]) {
    await expect(f.tools({ ...base, inputSchemaPath })).rejects.toThrow("PLUGIN_TOOL_SCHEMA_INVALID");
  }
  expect(f.received).toEqual([]);
});

test("command normalization carries the preflight schema instead of rereading changed source files", async () => {
  const f = await fixture(), path = join(f.pack, "schema.json"), command = join(f.pack, "must-not-start");
  await writeFile(path, JSON.stringify(schema)); await writeFile(command, "not an executable fixture");
  const { inputSchema: _inline, ...base } = f.contribution;
  const contribution = { ...base, command, inputSchemaPath: path, lifecycle: { ...base.lifecycle, transport: "oneshot" as const } };
  await f.runtime.startEager([{ ...f.plugin, toolContributions: [contribution] }]);
  await writeFile(path, JSON.stringify({ type: "object", additionalProperties: true }));
  const tool = (await f.tools(contribution))[0]!;
  tool.inputSchema.required = [];
  await expect(tool.execute({}, signal())).rejects.toThrow("PLUGIN_TOOL_INPUT_INVALID");
});

test("oneshot and stdio reject invalid parameters before child startup, then allow independent valid calls", async () => {
  const f = await fixture(), marker = join(f.pack, "started"), script = join(f.pack, "tool.mjs");
  await writeFile(script, `await Bun.write(${JSON.stringify(marker)},'started');
    if(process.argv[2]==='oneshot'){await Bun.stdin.text();console.log('accepted');}
    else {const {createInterface}=await import('node:readline');createInterface({input:process.stdin}).on('line',line=>console.log(JSON.stringify({id:JSON.parse(line).id,result:'accepted'})));}`);
  for (const transport of ["oneshot", "stdio"] as const) {
    await rm(marker, { force: true });
    const contribution = { ...f.contribution, id: transport, command: process.execPath, args: [script, transport], lifecycle: { ...f.contribution.lifecycle, transport } };
    await expect(f.runtime.call(f.plugin, contribution, { label: "ok" }, signal())).rejects.toThrow("PLUGIN_TOOL_INPUT_INVALID");
    expect(await readFile(marker, "utf8").catch(() => "")).toBe("");
    expect(await f.runtime.call(f.plugin, contribution, { label: "ok", count: 1 }, signal())).toBe("accepted");
    expect(await readFile(marker, "utf8")).toBe("started");
  }
});

test("eager preflight checks the entire package before starting its first child", async () => {
  const f = await fixture(), marker = join(f.pack, "started"), script = join(f.pack, "tool.mjs");
  await writeFile(script, `await Bun.write(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);`);
  const eager = { ...f.contribution, command: process.execPath, args: [script], lifecycle: { ...f.contribution.lifecycle, transport: "stdio" as const, start: "eager" as const } };
  await expect(f.runtime.startEager([{ ...f.plugin, toolContributions: [eager, { ...eager, id: "invalid", inputSchema: { type: "object", anyOf: [] } }] }])).rejects.toThrow("PLUGIN_TOOL_SCHEMA_INVALID");
  expect(await readFile(marker, "utf8").catch(() => "")).toBe("");
});

test("plain JSON checks reject silent normalization and hide parameter values in diagnostics", async () => {
  const f = await fixture(), contribution = { ...f.contribution, inputSchema: { type: "object", additionalProperties: true } };
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const input of [{ private: undefined }, { private: NaN }, { private: new Date() }, { private: () => "private-value" }, { private: { toJSON() { return "private-value"; } } }, cyclic]) {
    try { await f.runtime.call(f.plugin, contribution, input, signal()); throw new Error("unexpected effect"); }
    catch (error) { expect(String(error)).toContain("PLUGIN_TOOL_INPUT_INVALID"); expect(String(error)).not.toContain("private-value"); }
  }
  expect(f.received).toEqual([]);
});

test("tool inputs keep their 1 MiB byte budget rather than inheriting configuration's 128 KiB limit", async () => {
  const f = await fixture(), contribution = { ...f.contribution, inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] } };
  expect(await f.runtime.call(f.plugin, contribution, { body: "x".repeat(200 * 1024) }, signal())).toBe("accepted");
  await expect(f.runtime.call(f.plugin, contribution, { body: "x".repeat(1024 * 1024) }, signal())).rejects.toThrow("input exceeds");
  expect(f.received).toHaveLength(1);
});

test("schema and input structural budgets reject excessive nesting and width without effects", () => {
  let nested: unknown = { type: "string" }; for (let i = 0; i < 18; i++) nested = { type: "object", properties: { nested } };
  for (const invalid of [nested, { type: "object", properties: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), { type: "string" }])) }, { type: "object", title: 42 }]) {
    expect(() => compilePluginToolInputSchema(invalid)).toThrow("PLUGIN_TOOL_SCHEMA_INVALID");
  }
  const contract = compilePluginToolInputSchema();
  expect(() => contract.validate({ values: Array.from({ length: 8192 }, () => 1) }, 1024 * 1024)).toThrow("PLUGIN_TOOL_INPUT_INVALID");
  const closed = compilePluginToolInputSchema(schema); closed.schema.required = [];
  expect(() => closed.validate({}, 1024 * 1024)).toThrow("PLUGIN_TOOL_INPUT_INVALID");
});
