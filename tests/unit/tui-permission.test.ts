import { describe, expect, test } from "bun:test";

import { PermissionController } from "../../src/ui/permission-controller";

describe("TUI permission controller", () => {
  test("publishes one request and resolves the waiting permission check", async () => {
    const controller = new PermissionController();
    const snapshots: string[] = [];
    const unsubscribe = controller.subscribe(() => {
      snapshots.push(controller.current()?.tool.name ?? "none");
    });
    const decision = controller.request({
      tool: { name: "write", risk: "write", isReadOnly: () => false },
      input: { path: "notes.txt" },
      message: "write requires approval",
    });

    expect(controller.current()?.tool.name).toBe("write");
    controller.resolve("allow");

    expect(await decision).toBe("allow");
    expect(controller.current()).toBeUndefined();
    expect(snapshots).toEqual(["write", "none"]);
    unsubscribe();
  });

  test("returns a session-level allow decision", async () => {
    const controller = new PermissionController();
    const decision = controller.request({
      tool: { name: "bash", risk: "execute", isReadOnly: () => false },
      input: { command: "bun test" },
      message: "bash requires approval",
      suggestedRule: "Bash(bun test)",
    });

    controller.resolve("allow-session");
    expect(await decision).toBe("allow-session");
  });

  test("rejects overlapping permission prompts instead of losing a resolver", async () => {
    const controller = new PermissionController();
    const request = {
      tool: { name: "bash", risk: "execute" as const, isReadOnly: () => false },
      input: { command: "bun test" },
      message: "approval required",
    };
    const first = controller.request(request);

    expect(controller.request(request)).rejects.toThrow("already pending");
    controller.resolve("deny");
    expect(await first).toBe("deny");
  });

  test("clears a pending permission prompt when its request is cancelled", async () => {
    const controller = new PermissionController();
    const abort = new AbortController();
    const request = controller.request({
      tool: { name: "sampling", risk: "network", isReadOnly: () => false },
      input: { phase: "request" },
      message: "approval required",
    }, abort.signal);

    abort.abort(new Error("server cancelled"));
    await expect(request).rejects.toThrow("server cancelled");
    expect(controller.current()).toBeUndefined();
  });
});
