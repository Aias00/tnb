import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";

import { editPromptInExternalEditor, editorCommand } from "../../src/ui/external-editor";

describe("external prompt editor", () => {
  test("parses quoted editor arguments and adds GUI wait flags", () => {
    expect(editorCommand('code --profile "Work Profile"')).toEqual(["code", "--profile", "Work Profile", "--wait"]);
    expect(editorCommand('"C:\\Program Files\\Microsoft VS Code\\Code.exe" --reuse-window')).toEqual([
      "C:\\Program Files\\Microsoft VS Code\\Code.exe",
      "--reuse-window",
      "--wait",
    ]);
    expect(editorCommand("nvim -f")).toEqual(["nvim", "-f"]);
    expect(() => editorCommand("nvim 'broken")).toThrow("unterminated quote");
  });

  test("hands off the renderer, reads edited content, and restores the renderer", async () => {
    const lifecycle: string[] = [];
    const commands: string[][] = [];
    const result = await editPromptInExternalEditor({
      value: "before",
      editor: "nvim -f",
      stdout: process.stdout,
      handoff: {
        enter: () => lifecycle.push("enter"),
        exit: () => lifecycle.push("exit"),
      },
      run: async (command) => {
        commands.push(command);
        await writeFile(command.at(-1)!, "after", "utf8");
        return 0;
      },
    });

    expect(result).toEqual({ content: "after" });
    expect(commands[0]?.slice(0, -1)).toEqual(["nvim", "-f"]);
    expect(lifecycle).toEqual(["enter", "exit"]);
  });
});
