import { describe, expect, test } from "bun:test";

import { runCompletionCommand } from "../../src/services/cli/completion";

describe("shell completion command", () => {
  for (const shell of ["bash", "zsh", "fish"] as const) {
    test(`renders ${shell} completion with core and provider commands`, () => {
      let stdout = "";
      let stderr = "";
      const code = runCompletionCommand({
        argv: ["completion", shell],
        stdout: { write: (text) => { stdout += text; } },
        stderr: { write: (text) => { stderr += text; } },
      });
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("tnb");
      expect(stdout).toContain("provider");
      expect(stdout).toContain("completion");
    });
  }

  test("rejects unsupported shells", () => {
    let stderr = "";
    expect(runCompletionCommand({ argv: ["completion", "powershell"], stdout: { write: () => undefined }, stderr: { write: (text) => { stderr += text; } } })).toBe(1);
    expect(stderr).toContain("bash, zsh, or fish");
  });
});
