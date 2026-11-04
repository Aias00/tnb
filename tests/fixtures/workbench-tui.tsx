import { appendFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runTui } from "../../src/ui/app";
import { FileInputQueueStorage } from "../../src/ui/input-queue";
import type { QuestionInbox, InboxQuestion } from "../../src/services/runtime/attention";
import type { RunPresentation } from "../../src/services/runtime/presentation";
import { ShellSessionManager } from "../../src/services/shell/manager";

const trigger = process.env.TNB_WORKBENCH_FIXTURE!, workspace = dirname(trigger);
const shells = new ShellSessionManager({ cwd: workspace, outputDir: join(workspace, "shells") });
let ptyPid: number | undefined;
const listeners = new Set<() => void>(), dismissed = new Set<string>();
const connection = { state: "online" as const, message: "" };
let questions: InboxQuestion[] = [], failAnswer = false, hold: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let runs: RunPresentation[] = [{ runId: "run-one", revision: 1, title: "后台改造", workspace, mode: "auto", status: "active", phase: "等待子任务", updatedAt: 1, checks: 0,
  budget: { reported: 0, reserved: 0, requests: 2, limit: 256, priced: false }, tasks: [{ taskId: "root", title: "主任务", status: "waiting", phase: "等待子任务" }], inputs: [] }];
const emit = () => { for (const listener of listeners) listener(); };
const inbox: QuestionInbox = {
  current: () => questions, runs: () => runs, connection: () => connection,
  subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  next: () => questions.find((row) => !dismissed.has(row.waitId!)),
  dismiss: (row) => { dismissed.add(row.waitId!); questions = [...questions]; emit(); },
  answer: async (row, answer) => {
    await appendFile(trigger + ".attempts", answer + "\n");
    if (failAnswer) { failAnswer = false; throw new Error("暂时无法提交，请重试"); }
    await appendFile(trigger + ".answers", answer + "\n"); questions = questions.filter((item) => item.waitId !== row.waitId); emit(); return { paused: false };
  },
  control: async (runId, action, _revision, commandId) => {
    await appendFile(trigger + ".controls", `${action} ${runId} ${commandId}\n`);
    runs = runs.map((run) => run.runId !== runId ? run : ({ ...run, revision: run.revision + 1, status: action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "active", phase: action === "cancel" ? "已取消" : action === "pause" ? "用户暂停" : "待执行" })); emit();
  },
  followup: async (runId, text, inputId) => {
    await appendFile(trigger + ".followups", text + "\n");
    runs = runs.map((run) => ({ ...run, inputs: [{ inputId, text, state: "pending", revision: 1 }] })); emit();
    return { inputId, workspace, rawText: text, source: "conversation", action: "followup", status: "accepted", reason: "bound-existing-task", revision: 1, policyRevision: 1, runId, candidates: [], at: Date.now() };
  },
  inspect: async () => ({ run: runs[0]!, report: "交付报告", acceptance: "report-delivered", checks: [], changes: [], limitations: [], unresolved: [] }),
};
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const action = await request.text();
  if (action === "release") hold?.resolve();
  else if (action === "add-run") { runs = [...runs, { ...runs[0]!, runId: "run-two", title: "第二个任务" }]; emit(); }
  else if (action === "start-pty") {
    ptyPid = (await shells.startPty({ command: "printf PTY_READY; exec /bin/cat", waitMs: 100, idleMs: 20 })).pid;
    await writeFile(trigger + ".pty-pid", String(ptyPid));
  }
  else if (action === "read-pty") {
    const view = await shells.readPty({ pid: ptyPid!, waitMs: 100, idleMs: 20 });
    await writeFile(trigger + ".pty-output", view.screen); await writeFile(trigger + ".pty-alive", String(view.alive));
  }
  else if (action === "close-shells") await shells.close();
  else if (action === "ask") {
    questions = [{ waitId: "question-one", runId: "run-one", taskId: "root", version: 1, digest: "fixture", state: "open", createdAt: 1, runObjective: "后台改造", runStatus: "active",
      proposal: { kind: "question", key: "database", question: "选择数据库", options: ["SQLite（推荐）", "Postgres"], about: "业务决定" } }]; dismissed.clear(); emit();
  } else if (action === "fail-answer") failAnswer = true;
  await appendFile(trigger + ".actions", action + "\n"); return new Response("ok");
} });
await writeFile(trigger + ".control", String(server.url));
try {
  await runTui({ model: "fixture-model", permissionMode: "default", sessionIdFactory: () => "workbench", durableQuestions: inbox,
    workspace: () => workspace, queueStorage: new FileInputQueueStorage(join(workspace, "config")), shellManager: shells,
    runTurn: async (turn) => {
      await appendFile(trigger + ".turns", turn.input.expanded + "\n");
      if (turn.input.expanded === "approval") {
        const answer = await turn.permissionPrompt({ tool: { name: "bash", risk: "execute", isReadOnly: () => false },
          input: { command: "echo " + "x".repeat(1200) + " FINAL_COMMAND_MARKER", cwd: workspace }, message: "Review complete command", suggestedRule: "Bash(echo *)" });
        await appendFile(trigger + ".permissions", answer + "\n");
      }
      if (turn.input.expanded === "hold") {
        hold = Promise.withResolvers<void>();
        await Promise.race([hold.promise, new Promise<void>((resolve) => turn.signal.addEventListener("abort", () => resolve(), { once: true }))]);
        if (turn.signal.aborted) throw new Error("Interrupted");
      }
    }, fullscreen: true });
} finally { hold?.resolve(); await shells.close(); await server.stop(true); }
