import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export type TerminalImageProtocol = "kitty" | "iterm";

export function detectTerminalImageProtocol(env: Record<string, string | undefined>): TerminalImageProtocol | undefined {
  if (env.KITTY_WINDOW_ID || env.TERM?.includes("kitty")) return "kitty";
  if (env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "WezTerm") return "iterm";
  return undefined;
}

export async function renderTerminalImage(path: string, env: Record<string, string | undefined>): Promise<string | undefined> {
  const protocol = detectTerminalImageProtocol(env);
  if (!protocol) return undefined;
  const data = (await readFile(path)).toString("base64");
  if (protocol === "iterm") {
    const name = Buffer.from(basename(path)).toString("base64");
    return `\u001B]1337;File=name=${name};inline=1;preserveAspectRatio=1:${data}\u0007`;
  }
  const chunks = data.match(/.{1,4096}/g) ?? [""];
  return chunks.map((chunk, index) => {
    const more = index < chunks.length - 1 ? 1 : 0;
    return `\u001B_G${index === 0 ? `a=T,f=100,m=${more}` : `m=${more}`};${chunk}\u001B\\`;
  }).join("");
}
