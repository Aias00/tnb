import type { PermissionAskRequest, PermissionPromptDecision } from "../core/permissions";
import type { AskUser, UserQuestion } from "../tools/interaction";
import { durableUserQuestion, questionNoticeKey, type QuestionInbox, type QuestionNotice } from "../services/runtime/attention";

export type ReplTurn = {
  prompt: string;
  sessionId: string;
  resume: boolean;
};

export type ReplOptions = {
  question(prompt: string): Promise<string>;
  write(text: string): void;
  runTurn(turn: ReplTurn): Promise<number>;
  handleCommand?(input: string): Promise<boolean>;
  sessionIdFactory(): string;
  durableQuestions?: QuestionInbox;
  inputValue?(): string;
};

export async function runRepl(options: ReplOptions): Promise<number> {
  const sessionId = options.sessionIdFactory();
  let hasRun = false;
  options.write("tnb interactive · /exit to quit\n");
  const inbox = options.durableQuestions, announced = new Set<string>();
  let awaitingInput = false, inputQuestion: QuestionNotice | undefined;
  const show = (notice: QuestionNotice) => {
    const question = durableUserQuestion(notice);
    options.write(`\n${question.header}\n${question.question}\n`);
    question.options.forEach((option, index) => options.write(`  ${index + 1}. ${option.label}\n`));
  };
  const notify = () => {
    const fresh = inbox?.current().filter((question) => !announced.has(questionNoticeKey(question))) ?? [];
    fresh.forEach((question) => announced.add(questionNoticeKey(question)));
    if (!fresh.length) return;
    if (awaitingInput && !inputQuestion && options.inputValue?.() === "") {
      inputQuestion = inbox!.next();
      if (inputQuestion) { show(inputQuestion); options.write("直接输入选项编号或答案；/later 稍后处理："); }
    } else {
      show(fresh[0]!); options.write(`有 ${inbox!.current().length} 个长任务问题待处理，当前输入和操作保留，结束后会询问。\n`);
    }
  };
  const unsubscribe = inbox?.subscribe(notify); notify();
  try {
    while (true) {
      if (!inputQuestion) {
        inputQuestion = inbox?.next();
        if (inputQuestion) show(inputQuestion);
      }
      awaitingInput = true;
      let input: string;
      try { input = (await options.question(inputQuestion ? "输入选项编号或答案（/later 稍后处理）：" : "› ")).trim(); }
      finally { awaitingInput = false; }
      if (!input) continue;
      if (input === "/exit" || input === "/quit") return 0;
      const asked = inputQuestion; inputQuestion = undefined;
      if (asked) {
        if (input === "/later") { inbox!.dismiss(asked); options.write("问题仍然保留，稍后可用 /task questions 处理。\n"); continue; }
        if (input.startsWith("/") && await options.handleCommand?.(input)) continue;
        if (!inbox!.current().some((question) => questionNoticeKey(question) === questionNoticeKey(asked))) {
          options.write("这个问题已处理或已失效，刚才的输入没有提交；请重新输入。\n"); continue;
        }
        const question = durableUserQuestion(asked), index = Number(input);
        const answer = Number.isInteger(index) && index >= 1 && index <= question.options.length ? question.options[index - 1]!.label : input;
        try {
          const result = await inbox!.answer(asked, answer);
          options.write(result.paused ? "回答已保存；任务保持暂停，恢复后继续。\n" : "回答已保存，长任务会继续执行。\n");
        } catch (error) {
          inbox!.dismiss(asked);
          options.write(`回答未提交：${error instanceof Error ? error.message : String(error)}。问题保留，可用 /task questions 核对并重试。\n`);
        }
        continue;
      }
      if (await options.handleCommand?.(input)) continue;
      const exitCode = await options.runTurn({ prompt: input, sessionId, resume: hasRun });
      if (exitCode === 0) hasRun = true;
    }
  } finally { unsubscribe?.(); }
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
