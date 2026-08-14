import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_KEYBINDINGS, loadKeybindings, matchesKeybinding } from "../../src/ui/keybindings";

const key = {
  ctrl: false,
  shift: false,
  meta: false,
};

describe("TUI keybindings", () => {
  test("uses Claude-style defaults and matches modifier keys exactly", () => {
    expect(matchesKeybinding(DEFAULT_KEYBINDINGS, "historySearch", "r", { ...key, ctrl: true })).toBe(true);
    expect(matchesKeybinding(DEFAULT_KEYBINDINGS, "historySearch", "r", { ...key, ctrl: true, shift: true })).toBe(false);
  });

  test("loads overrides and permits disabling an action", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tnb-keybindings-"));
    try {
      await writeFile(join(directory, "keybindings.json"), JSON.stringify({
        bindings: { historySearch: "ctrl+h", pasteImage: null },
      }));
      const bindings = await loadKeybindings(directory);
      expect(bindings).toMatchObject({ historySearch: "ctrl+h", pasteImage: null, externalEditor: "ctrl+g" });
      expect(matchesKeybinding(bindings, "historySearch", "h", { ...key, ctrl: true })).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects unknown actions instead of silently ignoring them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tnb-keybindings-"));
    try {
      await writeFile(join(directory, "keybindings.json"), JSON.stringify({ bindings: { launchMissiles: "ctrl+x" } }));
      await expect(loadKeybindings(directory)).rejects.toThrow("Unknown keybinding action");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
