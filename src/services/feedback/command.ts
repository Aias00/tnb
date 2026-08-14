import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

type Writer = { write(text: string): unknown };

export async function runFeedbackCommand(options: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  stdout: Writer;
  stderr: Writer;
  version: string;
}): Promise<number> {
  try {
    if (options.argv.includes("--help") || options.argv.includes("-h")) {
      options.stdout.write(`Usage: tnb feedback -c <comment> [-i <image>]... [-s <session-id>]

Submits multipart feedback to TNB_FEEDBACK_URL. The endpoint receives
comment, session_id, version, cwd, platform, and repeated images fields.
`);
      return 0;
    }
    const endpoint = options.env.TNB_FEEDBACK_URL;
    if (!endpoint) throw new Error("TNB_FEEDBACK_URL is required to submit feedback");
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("TNB_FEEDBACK_URL must use HTTP or HTTPS");
    }
    const comment = optionValue(options.argv, ["--comment", "-c"]);
    if (!comment?.trim()) throw new Error("feedback requires -c or --comment");
    const form = new FormData();
    form.set("comment", comment.trim());
    form.set("version", options.version);
    form.set("cwd", resolve(options.cwd));
    form.set("platform", `${process.platform}/${process.arch}`);
    const sessionId = optionValue(options.argv, ["--session", "-s"]);
    if (sessionId) form.set("session_id", sessionId);
    for (const path of optionValues(options.argv, ["--image", "-i"])) {
      const absolute = resolve(options.cwd, path);
      if (!(await stat(absolute)).isFile()) throw new Error(`Feedback image is not a file: ${path}`);
      form.append("images", new Blob([await readFile(absolute)]), basename(absolute));
    }
    const response = await fetch(url, { method: "POST", body: form });
    const body = await response.text();
    if (!response.ok) throw new Error(`Feedback endpoint returned ${response.status}: ${body.slice(0, 1_000)}`);
    options.stdout.write(`${body.trim() || "Feedback submitted."}\n`);
    return 0;
  } catch (error) {
    options.stderr.write(`tnb: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function optionValue(argv: string[], names: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    if (!names.includes(argv[index]!)) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`${argv[index]} requires a value`);
    return value;
  }
  return undefined;
}

function optionValues(argv: string[], names: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (!names.includes(argv[index]!)) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`${argv[index]} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}
