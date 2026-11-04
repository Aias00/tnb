import { expect, test } from "bun:test";
import { parseSlashCommand, slashCommandHelp, suggestSlashCommands } from "../../src/ui/slash-commands";

test("long tasks are discoverable slash commands with aliases in the shared parser", () => {
  for (const name of ["longtask", "long", "长任务", "LONGTASK"]) {
    expect(parseSlashCommand(`/${name} status`)).toMatchObject({ kind: "command", command: { name: "longtask", argument: "status" } });
  }
  expect(suggestSlashCommands("/long").some((command) => command.name === "longtask")).toBe(true);
  expect(suggestSlashCommands("/长").some((command) => command.name === "longtask")).toBe(true);
  expect(slashCommandHelp()).toContain('/longtask "objective"');
});
