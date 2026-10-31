import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessage } from "../../src/core/message";
import { runAgentLoop } from "../../src/core/agent-loop";
import { createPermissionChecker } from "../../src/core/permissions";
import { defineTool } from "../../src/core/tool";
import { assertBalancedToolHistory } from "../../src/core/history";
import type { ModelEvent, ModelRequest, ModelTransport } from "../../src/providers/types";
import { createEditTool, createReadTool } from "../../src/tools/builtins";
import { createFileStateCacheWithSizeLimit } from "../../src/utils/file-state-cache";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function scripted(responses: ModelEvent[][], requests: ModelRequest[] = []): ModelTransport {
  return { async *stream(request) { requests.push(structuredClone(request)); yield* responses[requests.length - 1]!; } };
}
const call = (id = "call"): ModelEvent[] => [
  { type: "tool-start", index: 0, id, name: "write" },
  { type: "tool-input", index: 0, json: "{}" },
  { type: "response-end", reason: "tool-use" },
];
const done: ModelEvent[] = [{ type: "response-end", reason: "end-turn" }];

describe("runtime invariants across module boundaries", () => {
  test("a pre-hook allow cannot bypass an explicit deny or a mandatory ask", async () => {
    for (const rules of [{ deny: ["write"] }, { ask: ["write"] }]) {
      let effects = 0;
      const tool = defineTool({ name: "write", description: "write", inputSchema: {}, access: "write", validate: (x) => x,
        execute: async () => { effects++; return "written"; } });
      const check = createPermissionChecker({ mode: "default", rules });
      const result = await runAgentLoop({ model: "fixture", prompt: "act", tools: [tool], transport: scripted([call(), done]),
        beforeTool: async () => ({ decision: { behavior: "allow" } }),
        authorize: (tool, input, context) => check({ name: tool.name, risk: tool.access, isReadOnly: tool.isReadOnly }, input, undefined, context),
      });
      expect(effects).toBe(0);
      expect(result.messages.flatMap((m): ConversationMessage["content"][number][] => m.content).find((b) => b.type === "tool-result")?.isError).toBe(true);
    }
  });

  test("plan permits investigation but still rejects writes", async () => {
    const check = createPermissionChecker({ mode: "plan" });
    expect(await check({ name: "read", risk: "read", isReadOnly: () => true }, {})).toEqual({ behavior: "allow" });
    expect((await check({ name: "write", risk: "write", isReadOnly: () => false }, {})).behavior).toBe("deny");
  });

  test("permission hook input rewrites cannot enter an explicitly denied target", async () => {
    const check = createPermissionChecker({ mode: "default", rules: { deny: ["write(secret.txt)"] },
      onPermissionRequest: async () => ({ behavior: "allow", updatedInput: { path: "secret.txt" } }),
    });
    expect((await check({ name: "write", risk: "write", isReadOnly: () => false,
      permissionRuleContent: (input) => (input as { path: string }).path }, { path: "allowed.txt" })).behavior).toBe("deny");
  });

  test("truncated tool arguments are never parsed or left unresolved in the continuation", async () => {
    const requests: ModelRequest[] = [];
    const result = await runAgentLoop({ model: "fixture", prompt: "act", tools: [], authorize: async () => ({ behavior: "allow" }),
      transport: scripted([[
        { type: "text", index: 0, text: "partial" },
        { type: "tool-start", index: 1, id: "cut", name: "write" },
        { type: "tool-input", index: 1, json: '{"path":' },
        { type: "response-end", reason: "max-tokens" },
      ], done], requests),
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.flatMap((m): ConversationMessage["content"][number][] => m.content).some((b) => b.type === "tool-use")).toBe(false);
    expect(() => assertBalancedToolHistory(result.messages)).not.toThrow();
  });

  test("a failed post-hook cannot relabel an already successful action", async () => {
    let effects = 0;
    const tool = defineTool({ name: "write", description: "write", inputSchema: {}, validate: (x) => x,
      execute: async () => { effects++; return "actual result"; } });
    const result = await runAgentLoop({ model: "fixture", prompt: "act", tools: [tool], authorize: async () => ({ behavior: "allow" }),
      transport: scripted([call(), done]), afterTool: async () => { throw new Error("observer failure"); },
    });
    const outcome = result.messages.flatMap((m): ConversationMessage["content"][number][] => m.content).find((b) => b.type === "tool-result");
    expect(effects).toBe(1);
    expect(outcome?.isError).toBe(false);
    expect(outcome?.content).toContain("actual result");
    expect(outcome?.content).toContain("observer failure");
  });

  test("concurrent editors with separate read receipts reject a stale writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-edit-race-")); roots.push(root);
    await writeFile(join(root, "code.txt"), "left=old\nright=old\n");
    const signal = new AbortController().signal;
    const editors = await Promise.all([0, 1].map(async () => {
      const cache = createFileStateCacheWithSizeLimit(100);
      await createReadTool(root, undefined, undefined, cache).execute({ path: "code.txt" }, signal);
      return createEditTool(root, undefined, cache);
    }));
    const results = await Promise.allSettled(editors.map((editor, i) => editor.execute({ path: "code.txt", oldText: i ? "right=old" : "left=old", newText: i ? "right=NEW" : "left=NEW", replaceAll: false }, signal)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await readFile(join(root, "code.txt"), "utf8")).toMatch(/(?:left|right)=NEW/);
  });

  test("tools are rebound between requests, and pending calls retain their advertised implementation", async () => {
    let phase = 0;
    const used: string[] = [];
    const make = (version: string) => defineTool({ name: "write", description: version, inputSchema: {}, validate: (x) => x,
      execute: async () => { used.push(version); return version; } });
    const old = make("old"), fresh = make("fresh");
    const requests: ModelRequest[] = [];
    const transport: ModelTransport = { async *stream(request) {
      requests.push(request); phase++;
      if (phase === 1) yield* call("first"); else yield* done;
    } };
    await runAgentLoop({ model: "fixture", prompt: "act", tools: [old], resolveTools: () => [phase ? fresh : old], transport,
      authorize: async () => ({ behavior: "allow" }),
    });
    expect(used).toEqual(["old"]);
    expect(requests[1]!.tools[0]!.description).toBe("fresh");
  });
});

test("duplicate IDs within one tool round are rejected before any side effect", async () => {
  let effects = 0;
  const tool = defineTool({ name: "write", description: "fixture", inputSchema: {}, validate: (x) => x,
    execute: async () => { effects++; return "written"; } });
  await expect(runAgentLoop({ model: "fixture", prompt: "act", tools: [tool], authorize: async () => ({ behavior: "allow" }),
    transport: { async *stream() {
      for (const index of [0, 1]) { yield { type: "tool-start", index, id: "same", name: "write" }; yield { type: "tool-input", index, json: "{}" }; }
      yield { type: "response-end", reason: "tool-use" };
    } },
  })).rejects.toThrow("Duplicate");
  expect(effects).toBe(0);
});
