export type GitResult = { stdout: string; stderr: string; exitCode: number };

export async function runGit(
  cwd: string,
  args: string[],
  options: { env?: Record<string, string | undefined>; allowFailure?: boolean } = {},
): Promise<GitResult> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const result = { stdout, stderr, exitCode };
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(stderr.trim() || `git ${args[0] ?? "command"} exited with code ${exitCode}`);
  }
  return result;
}

export async function gitRoot(cwd: string): Promise<string> {
  const result = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  return result.stdout.trim();
}
