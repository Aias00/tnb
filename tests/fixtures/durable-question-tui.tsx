import { watch } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { runTui } from "../../src/ui/app";
import type { QuestionInbox, QuestionNotice, ConnectionStatus } from "../../src/services/runtime/attention";
import type { RunNotice } from "../../src/services/runtime/notices";

const trigger = process.env.TNB_QUESTION_FIXTURE!;
let questions: QuestionNotice[] = [];
let notifications: RunNotice[] = [], connection: ConnectionStatus = { state: "online", message: "" };
const listeners = new Set<() => void>(), dismissed = new Set<string>();
const acknowledged = new Set<string>();
const inbox: QuestionInbox = {
  current: () => questions,
  notifications: () => notifications,
  connection: () => connection,
  acknowledge: async (notice) => {
    if (!acknowledged.has(notice.noticeId)) { acknowledged.add(notice.noticeId); await appendFile(trigger + ".acks", notice.noticeId + "\n"); }
    notifications = notifications.filter((current) => current.noticeId !== notice.noticeId); listeners.forEach((listener) => listener());
  },
  subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  next: () => questions.find((question) => !dismissed.has(question.waitId)),
  dismiss: (question) => { dismissed.add(question.waitId); questions = [...questions]; listeners.forEach((listener) => listener()); },
  answer: async (question, answer) => {
    await appendFile(trigger + ".answers", answer + "\n");
    questions = questions.filter((current) => current.waitId !== question.waitId); listeners.forEach((listener) => listener());
    return { paused: false };
  },
};
const watcher = watch(dirname(trigger), async (_event, file) => {
  if (file !== trigger.split("/").at(-1)) return;
  const action = await readFile(trigger, "utf8").catch(() => "");
  if (action === "offline") connection = { state: "offline", message: "后台服务离线，请重启服务" };
  else if (action === "online") connection = { state: "online", message: "" };
  else if (action === "done") notifications = acknowledged.has("completed-one") ? [] : [{ noticeId: "completed-one", runId: "run-one", objective: "长任务", kind: "succeeded", message: "长任务已完成并通过验收", at: 1 }];
  else if (action === "withdraw-first") questions = questions.filter((question) => question.waitId !== "question-one");
  else questions = action === "ask" || action === "ask-two" ? [{ waitId: "question-one", runId: "run-one", taskId: "task-one", version: 1, digest: "fixture", state: "open", createdAt: 1,
    runObjective: "长任务分析", runStatus: "active", proposal: { kind: "question", key: "database", question: "选择数据库", options: ["SQLite", "Postgres"], about: "继续分析" } }] : [];
  if (action === "ask-two") questions.push({ waitId: "question-two", runId: "run-two", taskId: "task-two", version: 1, digest: "fixture", state: "open", createdAt: 2,
    runObjective: "另一个长任务", runStatus: "active", proposal: { kind: "question", key: "cache", question: "选择缓存", options: ["Redis", "Memory"], about: "继续分析" } });
  listeners.forEach((listener) => listener());
});
try {
  await runTui({ model: "fixture-model", permissionMode: "default", sessionIdFactory: () => "question-ui", durableQuestions: inbox,
    runTurn: async (turn) => { await appendFile(trigger + ".turns", turn.input.expanded + "\n"); }, fullscreen: true });
} finally { watcher.close(); }
