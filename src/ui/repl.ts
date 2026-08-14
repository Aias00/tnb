import type { PermissionAskRequest, PermissionPromptDecision } from "../core/permissions";
import type { AskUser, UserQuestion } from "../tools/interaction";

export type ReplTurn = {
  prompt: string;
  sessionId: string;
  resume: boolean;
};

export type ReplOptions = {
  question(prompt: string): Promise<string>;
  write(text: string): void;
  runTurn(turn: ReplTurn): Promise<number>;
  sessionIdFactory(): string;
};

export async function runRepl(options: ReplOptions): Promise<number> {
  const sessionId = options.sessionIdFactory();
  let hasRun = false;
  options.write("tnb interactive · /exit to quit\n");
  while (true) {
    const input = (await options.question("› ")).trim();
    if (!input) continue;
    if (input === "/exit" || input === "/quit") return 0;
    const exitCode = await options.runTurn({ prompt: input, sessionId, resume: hasRun });
    if (exitCode === 0) hasRun = true;
  }
}

export function createTerminalPermissionPrompt(options: {
  question(prompt: string): Promise<string>;
  write(text: string): void;
}): (request: PermissionAskRequest, signal?: AbortSignal) => Promise<PermissionPromptDecision> {
  return async (request, signal) => {
    signal?.throwIfAborted();
    options.write(`\nPermission required: ${request.message}\n`);
    options.write(`${request.tool.name} ${JSON.stringify(request.input, null, 2)}\n`);
    while (true) {
      const answer = (await options.question(request.suggestedRule ? "Allow? [y] once / [s] session / [a] always / [N] deny: " : "Allow once? [y/N] ")).trim().toLowerCase();
      signal?.throwIfAborted();
      if (answer === "y" || answer === "yes") return "allow";
      if (request.suggestedRule && (answer === "s" || answer === "session")) return "allow-session";
      if (request.suggestedRule && (answer === "a" || answer === "always")) return "allow-project";
      if (!answer || answer === "n" || answer === "no") return "deny";
      options.write(request.suggestedRule ? "Enter y, s, a, or n.\n" : "Enter y or n.\n");
    }
  };
}

export function createTerminalQuestionPrompt(options: {
  question(prompt: string): Promise<string>;
  write(text: string): void;
}): AskUser {
  return async (request, signal) => {
    signal.throwIfAborted();
    options.write(`\n${request.header}: ${request.question}\n`);
    request.options.forEach((option, index) => {
      options.write(`  ${index + 1}. ${option.label} — ${option.description}\n`);
    });
    options.write(`  ${request.options.length + 1}. Other — Enter a custom answer.\n`);
    while (true) {
      const answer = (await options.question(questionPrompt(request))).trim();
      signal.throwIfAborted();
      if (!answer) {
        options.write("Enter an option number, label, or custom answer.\n");
        continue;
      }
      const parsed = parseTerminalAnswer(request, answer);
      if (parsed) return parsed;
      options.write("For multiple choices, enter option numbers separated by commas.\n");
    }
  };
}

function questionPrompt(question: UserQuestion): string {
  return question.multiSelect ? "Select one or more choices: " : "Select a choice: ";
}

function parseTerminalAnswer(question: UserQuestion, answer: string): string | undefined {
  const tokens = question.multiSelect ? answer.split(",").map((value) => value.trim()) : [answer];
  const selected: string[] = [];
  for (const token of tokens) {
    const index = Number(token);
    if (Number.isInteger(index) && index >= 1 && index <= question.options.length) {
      selected.push(question.options[index - 1]!.label);
      continue;
    }
    const option = question.options.find(({ label }) => label.toLowerCase() === token.toLowerCase());
    if (option) {
      selected.push(option.label);
      continue;
    }
    if (tokens.length === 1) return token;
    return undefined;
  }
  return [...new Set(selected)].join(", ");
}
