import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../../src/core/tool-runtime";
import type { AgentLoopOptions } from "../../src/core/agent-loop";
import { createWriteTool } from "../../src/tools/builtins";
import { createShellTools } from "../../src/tools/shell";
import { ShellSessionManager } from "../../src/services/shell/manager";
import { createMcpTools } from "../../src/services/mcp/tools";
import { createSandboxRuntime } from "../../src/services/sandbox/factory";
import { createSandboxHost } from "../../src/services/sandbox/shared";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "tnb-bind-")); roots.push(root); return root; }
function options(tools: AgentLoopOptions["tools"], extra: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return { tools, model: "fixture", prompt: "fixture", transport: { async *stream() {} }, authorize: async () => ({ behavior: "allow" }), ...extra };
}
const signal = () => new AbortController().signal;

test("a failed sandbox launch probe prevents the original shell command and never falls back", async () => {
  const root = await fixture();
  const template = createSandboxRuntime({ requested: true, env: process.env }, {
    ...createSandboxHost(process.env), platform: "darwin", canExecute: () => true,
  });
  // The adapter shape is enough; this test checks the manager boundary on every OS.
  const sandbox = { ...template!, enabled: true as const, wrap() {
    return { file: process.execPath, args: ["-e", "process.exit(73)"] };
  } };
  const manager = new ShellSessionManager({ cwd: root, outputDir: join(root, "logs"), sandbox });
  try {
    await expect(manager.runForeground("echo should-not-run", 5000, signal())).rejects.toThrow("Sandbox launch probe failed");
    expect(manager.runtimeSnapshots()).toEqual([]);
  } finally { await manager.close(); }
});

test("authorization cannot mutate the arguments that are subsequently executed", async () => {
  const root = await fixture();
  const result = await executeTool({ type: "tool-use", id: "call", name: "write", input: { path: "approved", content: "yes" } },
    options([createWriteTool(root)], { authorize: async (_, input) => { (input as { path: string }).path = "unapproved"; return { behavior: "allow" }; } }), signal());
  expect(result.result.isError, result.result.content).toBe(false);
  expect(await readFile(join(root, "approved"), "utf8")).toBe("yes");
  expect(await Bun.file(join(root, "unapproved")).exists()).toBe(false);
});

test("workspace and roots are pinned before waiting for approval", async () => {
  const first = await fixture(); const second = await fixture();
  let cwd = first;
  const tool = createWriteTool(() => cwd);
  const result = await executeTool({ type: "tool-use", id: "call", name: "write", input: { path: "approved", content: "yes" } },
    options([tool], { authorize: async () => { cwd = second; return { behavior: "allow" }; } }), signal());
  expect(result.result.isError, result.result.content).toBe(false);
  expect(await readFile(join(first, "approved"), "utf8")).toBe("yes");
  expect(await Bun.file(join(second, "approved")).exists()).toBe(false);
});

test("policy revisions invalidate approval, including changes after journal I/O", async () => {
  for (const during of ["approval", "journal", "observer"]) {
    const root = await fixture(); let revision = 0;
    const result = await executeTool({ type: "tool-use", id: "call", name: "write", input: { path: "no-effect", content: "no" } }, options([createWriteTool(root)], {
      executionContext: () => revision,
      authorize: async () => { if (during === "approval") revision++; return { behavior: "allow" }; },
      callJournal: { intend: async () => { if (during === "journal") revision++; return "id"; }, dispatch: async () => {}, settle: async () => {} },
      onToolEvent: () => { if (during === "observer") revision++; },
    }), signal()).catch((error: Error) => error);
    expect(await Bun.file(join(root, "no-effect")).exists()).toBe(false);
    expect(result instanceof Error || result.result.isError).toBe(true);
  }
});

test("MCP connection recovery invalidates an approval for the previous session", async () => {
  let effects = 0;
  const client = { executionRevision: 1, async callTool() { effects++; return { content: [{ type: "text", text: "done" }] }; } };
  const tools = createMcpTools("fixture", client, [{ name: "act", inputSchema: { type: "object" } }]);
  const result = await executeTool({ type: "tool-use", id: "call", name: tools[0]!.name, input: {} }, options(tools, {
    authorize: async () => { client.executionRevision++; return { behavior: "allow" }; },
  }), signal());
  expect(effects).toBe(0);
  expect(result.result.content).toContain("MCP connection changed");
});

test.skipIf(process.platform === "win32")("background shell keeps its approved cwd across async startup and copies its environment", async () => {
  const first = await fixture(); const second = await fixture();
  const env = { PATH: process.env.PATH, BOUND_VALUE: "approved" };
  const manager = new ShellSessionManager({ cwd: first, outputDir: join(first, "logs"), env });
  env.BOUND_VALUE = "changed";
  const tool = createShellTools(manager, env)[0]!.bindExecution!();
  const running = tool.execute(tool.validate({ command: 'printf "%s" "$BOUND_VALUE" > result', run_in_background: true }), signal());
  manager.setCwd(second);
  try {
    await running;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const task = manager.runtimeSnapshots()[0];
      if (task?.kind === "background" && task.status !== "running") break;
      await Bun.sleep(10);
    }
    expect(manager.runtimeSnapshots()[0]).toMatchObject({ kind: "background", status: "completed" });
    expect(await readFile(join(first, "result"), "utf8")).toBe("approved");
    expect(await Bun.file(join(second, "result")).exists()).toBe(false);
  } finally { await manager.close(); }
});
