import { platform } from "node:os";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** BSD and util-linux script have different command and flush flags. */
export function ptyCommand(transcript: string, argv: readonly string[]): { file: string; args: string[] } {
  const command = argv.map(quote).join(" ");
  const script = platform() === "darwin"
    ? `script -q -F ${quote(transcript)} ${command}`
    : `script -q -e -f -c ${quote(command)} ${quote(transcript)}`;
  // A normal pipe also works with BSD script, which rejects socketpair stdin.
  return { file: "/bin/sh", args: ["-c", `cat | ${script}`] };
}
