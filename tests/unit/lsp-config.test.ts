import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadLspServerConfigs } from "../../src/services/lsp/config";

describe("LSP configuration", () => {
  test("discovers installed servers and lets project config override or disable them", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-lsp-config-"));
    const home = join(root, "home");
    const project = join(root, "project");
    await mkdir(join(project, ".tnb"), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(project, ".tnb", "lsp.json"), JSON.stringify({
      servers: {
        typescript: { disabled: true },
        custom: {
          command: "custom-lsp",
          args: ["--stdio"],
          extensionToLanguage: { foo: "foo" },
        },
      },
    }));
    const configs = await loadLspServerConfigs({
      configDir: home,
      cwd: project,
      env: {},
      which: (command) => command === "typescript-language-server" ? "/bin/typescript-language-server" : null,
    });
    expect(configs.map((config) => config.name)).toEqual(["custom"]);
    expect(configs[0]?.selectors).toEqual([{ languageId: "foo", extensions: [".foo"] }]);
  });
});
