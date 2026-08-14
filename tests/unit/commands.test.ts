import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expandCommandInput, loadCommands } from "../../src/services/commands/loader";

describe("custom commands", () => {
  test("loads nested commands and expands positional and complete arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-commands-"));
    const directory = join(root, "review");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "code.md"), [
      "---",
      "description: Review a target",
      "argument-hint: <path>",
      "---",
      "Review $1 with context: $ARGUMENTS",
    ].join("\n"));

    const loaded = await loadCommands([{ directory: root, source: "user" }]);
    const expanded = expandCommandInput("/review:code src/main.ts --strict", loaded.commands);

    expect(loaded.errors).toEqual([]);
    expect(loaded.commands[0]?.name).toBe("review:code");
    expect(expanded?.prompt).toBe("Review src/main.ts with context: src/main.ts --strict");
  });
});
