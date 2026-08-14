import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import instances from "./ink/instances";

export type ExternalEditorResult = {
  content?: string;
  error?: string;
};

type EditorHandoff = {
  enter(): void;
  exit(): void;
};

export async function editPromptInExternalEditor(options: {
  value: string;
  editor?: string;
  stdout: NodeJS.WriteStream;
  run?: (command: string[]) => Promise<number>;
  handoff?: EditorHandoff;
}): Promise<ExternalEditorResult> {
  const editor = options.editor?.trim();
  if (!editor) return { error: "No external editor configured. Set /editor, $VISUAL, or $EDITOR." };

  let command: string[];
  try {
    command = editorCommand(editor);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const directory = await mkdtemp(join(tmpdir(), "tnb-prompt-"));
  const path = join(directory, "prompt.md");
  await writeFile(path, options.value, "utf8");
  let handoff: EditorHandoff | undefined;
  let entered = false;
  try {
    handoff = options.handoff ?? rendererHandoff(options.stdout);
    handoff.enter();
    entered = true;
    const exitCode = await (options.run ?? runEditor)([...command, path]);
    if (exitCode !== 0) return { error: `${basename(command[0]!)} exited with code ${exitCode}` };
    return { content: await readFile(path, "utf8") };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (entered) handoff?.exit();
    await rm(directory, { recursive: true, force: true });
  }
}

export function editorCommand(value: string): string[] {
  const words = splitCommandLine(value);
  if (!words.length) throw new Error("External editor command is empty.");
  const executable = basename(words[0]!.replaceAll("\\", "/")).toLocaleLowerCase().replace(/\.exe$/, "");
  if ((executable === "code" || executable === "code-insiders") && !words.some((word) => word === "-w" || word === "--wait")) {
    words.push("--wait");
  } else if (executable === "subl" && !words.includes("--wait")) {
    words.push("--wait");
  }
  return words;
}

function splitCommandLine(value: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  const input = value.trim();
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === "\\" && quote !== "'") {
      const next = input[index + 1];
      if (next && (next === "\\" || next === '"' || next === "'" || /\s/.test(next))) {
        word += next;
        index += 1;
      } else {
        word += character;
      }
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (word) {
        words.push(word);
        word = "";
      }
    } else {
      word += character;
    }
  }
  if (quote) throw new Error("External editor command contains an unterminated quote.");
  if (word) words.push(word);
  return words;
}

function rendererHandoff(stdout: NodeJS.WriteStream): EditorHandoff {
  const instance = instances.get(stdout);
  if (!instance) throw new Error("The terminal renderer is unavailable for external editor handoff.");
  return {
    enter: () => instance.enterAlternateScreen(),
    exit: () => instance.exitAlternateScreen(),
  };
}

async function runEditor(command: string[]): Promise<number> {
  const child = Bun.spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}
