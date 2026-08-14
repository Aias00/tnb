import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTerminalImageProtocol, renderTerminalImage } from "../../src/ui/terminal-image";

describe("terminal image protocol", () => {
  test("detects supported terminals without guessing unknown ones", () => {
    expect(detectTerminalImageProtocol({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
    expect(detectTerminalImageProtocol({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm");
    expect(detectTerminalImageProtocol({ TERM_PROGRAM: "WezTerm" })).toBe("iterm");
    expect(detectTerminalImageProtocol({ TERM: "xterm-256color" })).toBeUndefined();
  });

  test("encodes inline images and safely declines unknown terminals", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-image-"));
    const path = join(root, "tiny.png");
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const iterm = await renderTerminalImage(path, { TERM_PROGRAM: "iTerm.app" });
    const kitty = await renderTerminalImage(path, { KITTY_WINDOW_ID: "1" });
    expect(iterm).toStartWith("\u001B]1337;File=");
    expect(iterm).toContain("inline=1");
    expect(kitty).toStartWith("\u001B_Ga=T,f=100,m=0;");
    expect(await renderTerminalImage(path, { TERM: "xterm" })).toBeUndefined();
  });
});
