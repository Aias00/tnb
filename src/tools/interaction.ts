import { defineTool, type AgentTool } from "../core/tool";
import {
  ASK_USER_QUESTION_TOOL_PROMPT,
  TODO_WRITE_TOOL_PROMPT,
} from "../constants/tool-prompts";

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export type TodoItem = {
  content: string;
  activeForm: string;
  status: TodoStatus;
};

export type QuestionOption = {
  label: string;
  description: string;
};

export type UserQuestion = {
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
};

export type AskUser = (question: UserQuestion, signal: AbortSignal) => Promise<string>;

export function createTodoWriteTool(options: {
  initialTodos?: TodoItem[];
  onChange?(todos: TodoItem[]): void;
} = {}): AgentTool {
  let current: TodoItem[] = structuredClone(options.initialTodos ?? []);
  return defineTool({
    name: "todo_write",
    description: TODO_WRITE_TOOL_PROMPT,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["todos"],
      properties: {
        todos: {
          type: "array",
          description: "The complete replacement task list for the current session.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["content", "activeForm", "status"],
            properties: {
              content: {
                type: "string",
                description: "Imperative task description, for example: Run tests.",
              },
              activeForm: {
                type: "string",
                description: "Present-continuous progress label, for example: Running tests.",
              },
              status: { type: "string", enum: TODO_STATUSES },
            },
          },
        },
      },
    },
    validate(input) {
      const record = inputRecord(input, "todo_write input");
      if (!Array.isArray(record.todos)) throw new Error("todo_write todos must be an array");
      return {
        todos: record.todos.map((value, index) => {
          const todo = inputRecord(value, `todo_write todos[${index}]`);
          const content = requiredString(todo.content, `todos[${index}].content`);
          const activeForm = requiredString(todo.activeForm, `todos[${index}].activeForm`);
          if (!TODO_STATUSES.includes(todo.status as TodoStatus)) {
            throw new Error(
              `todos[${index}].status must be pending, in_progress, or completed`,
            );
          }
          return { content, activeForm, status: todo.status as TodoStatus };
        }),
      };
    },
    async execute({ todos }) {
      const oldTodos = current;
      current = todos.every(({ status }) => status === "completed") ? [] : structuredClone(todos);
      options.onChange?.(structuredClone(current));
      return [
        "Todos have been modified successfully. Continue using the task list to track progress and proceed with the current tasks when applicable.",
        JSON.stringify({ oldTodos, newTodos: todos }),
      ].join("\n");
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
  });
}

export function createAskUserQuestionTool(options: {
  askUser?: AskUser;
} = {}): AgentTool {
  return defineTool({
    name: "ask_user_question",
    description: ASK_USER_QUESTION_TOOL_PROMPT,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["questions"],
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          description: "One to four questions to ask the user in order.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["header", "question", "options"],
            properties: {
              header: {
                type: "string",
                maxLength: 12,
                description: "Very short label displayed above the question, at most 12 characters.",
              },
              question: {
                type: "string",
                description: "Clear, specific question shown to the user.",
              },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                description: "Two to four distinct choices. Do not include an Other option.",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["label", "description"],
                  properties: {
                    label: {
                      type: "string",
                      description: "Concise display label, normally one to five words.",
                    },
                    description: {
                      type: "string",
                      description: "What selecting the option means, including relevant trade-offs.",
                    },
                  },
                },
              },
              multiSelect: {
                type: "boolean",
                description: "Allow more than one option when the choices are not mutually exclusive.",
                default: false,
              },
            },
          },
        },
      },
    },
    validate(input) {
      const record = inputRecord(input, "ask_user_question input");
      if (!Array.isArray(record.questions) || record.questions.length < 1 || record.questions.length > 4) {
        throw new Error("ask_user_question questions must contain 1 to 4 items");
      }
      const questions = record.questions.map((value, index) => validateQuestion(value, index));
      if (new Set(questions.map(({ question }) => question)).size !== questions.length) {
        throw new Error("ask_user_question question texts must be unique");
      }
      return { questions };
    },
    async execute({ questions }, signal) {
      if (!options.askUser) {
        throw new Error("ask_user_question requires an interactive user interface");
      }
      const answers: Record<string, string> = {};
      for (const question of questions) {
        signal.throwIfAborted();
        answers[question.question] = await options.askUser(question, signal);
      }
      const text = Object.entries(answers)
        .map(([question, answer]) => `"${question}"="${answer}"`)
        .join(", ");
      return `User has answered your questions: ${text}. Continue with these answers in mind.`;
    },
    access: "read",
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
  });
}

function validateQuestion(value: unknown, index: number): UserQuestion {
  const question = inputRecord(value, `questions[${index}]`);
  const header = requiredString(question.header, `questions[${index}].header`);
  if (header.length > 12) throw new Error(`questions[${index}].header must be at most 12 characters`);
  const text = requiredString(question.question, `questions[${index}].question`);
  if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 4) {
    throw new Error(`questions[${index}].options must contain 2 to 4 items`);
  }
  const options = question.options.map((value, optionIndex) => {
    const option = inputRecord(value, `questions[${index}].options[${optionIndex}]`);
    const label = requiredString(option.label, `questions[${index}].options[${optionIndex}].label`);
    if (label.toLowerCase() === "other") {
      throw new Error(`questions[${index}].options must not include Other`);
    }
    return {
      label,
      description: requiredString(
        option.description,
        `questions[${index}].options[${optionIndex}].description`,
      ),
    };
  });
  if (new Set(options.map(({ label }) => label)).size !== options.length) {
    throw new Error(`questions[${index}] option labels must be unique`);
  }
  if (question.multiSelect !== undefined && typeof question.multiSelect !== "boolean") {
    throw new Error(`questions[${index}].multiSelect must be a boolean`);
  }
  return { header, question: text, options, multiSelect: question.multiSelect ?? false };
}

function inputRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}
