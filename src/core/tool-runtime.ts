import type { AgentLoopOptions } from "./agent-loop";
import type { MediaBlock, ToolResultBlock, ToolUseBlock } from "./message";

/** Shared execution boundary for main agents, Skills and delegated agents. */
export async function executeTool(
  use: ToolUseBlock,
  options: AgentLoopOptions,
  signal: AbortSignal,
  scope?: string,
): Promise<{ result: ToolResultBlock; attachments: MediaBlock[] }> {
  const tool = options.toolCatalog
    ? options.toolCatalog.getTool(use.name)
    : options.tools.find((candidate) => candidate.name === use.name);
  if (!tool) return { result: toolError(use.id, `Unknown tool: ${use.name}`), attachments: [] };
  let started = false;
  let startedAt = 0;
  let invocationId: string | undefined;
  let journalBarrier = false;
  try {
    let input = tool.validate(use.input);
    const pre = await options.beforeTool?.({ id: use.id, name: use.name, input: structuredClone(input) });
    if (pre?.input !== undefined) input = tool.validate(pre.input);
    const decision = pre?.decision?.behavior === "deny"
      ? pre.decision
      : await options.authorize(tool, input, { toolUseId: use.id, preApproved: pre?.decision?.behavior === "allow" });
    if (decision.behavior === "deny") {
      return { result: toolError(use.id, decision.message), attachments: [] };
    }
    if (decision.updatedInput !== undefined) input = tool.validate(decision.updatedInput);
    signal.throwIfAborted();
    if (options.callJournal) {
      journalBarrier = true;
      invocationId = await options.callJournal.intend(use, input, scope);
      await options.callJournal.dispatch(invocationId);
      journalBarrier = false;
    }
    signal.throwIfAborted();
    startedAt = Date.now();
    emit(options, {
      type: "tool-execution-start",
      id: use.id,
      name: use.name,
      input: structuredClone(input),
      startedAt,
    });
    started = true;
    const output = await tool.execute(input, signal, (data) => {
      emit(options, {
        type: "tool-execution-progress",
        id: use.id,
        name: use.name,
        data: structuredClone(data),
      });
    });
    const content = typeof output === "string" ? output : output.content;
    const attachments = typeof output === "string" ? [] : output.attachments;
    if (invocationId && options.callJournal) {
      journalBarrier = true;
      await options.callJournal.settle(invocationId, {
        result: { type: "tool-result", toolUseId: use.id, content, isError: false }, attachments,
      });
      journalBarrier = false;
    }
    const post = await runAfterTool(options, {
      id: use.id,
      name: use.name,
      input: structuredClone(input),
      output: content,
      isError: false,
    });
    const resultContent = appendTextContext(content, [...(pre?.context ?? []), ...(post?.context ?? [])]);
    const outcome = {
      result: { type: "tool-result" as const, toolUseId: use.id, content: resultContent, isError: false },
      attachments,
    };
    if (invocationId && options.callJournal) {
      journalBarrier = true;
      await options.callJournal.settle(invocationId, outcome);
      journalBarrier = false;
    }
    emit(options, {
      type: "tool-execution-end",
      id: use.id,
      name: use.name,
      output: resultContent,
      isError: false,
      durationMs: Date.now() - startedAt,
    });
    return outcome;
  } catch (error) {
    if (journalBarrier) throw new Error(`Tool journal failed for ${use.name}; stop and reconcile before retrying`, { cause: error });
    const message = error instanceof Error ? error.message : String(error);
    const post = await options.afterTool?.({
      id: use.id,
      name: use.name,
      input: use.input,
      output: message,
      isError: true,
    }).catch(() => undefined);
    const resultContent = appendTextContext(message, post?.context);
    const outcome = { result: toolError(use.id, resultContent), attachments: [] };
    if (invocationId && options.callJournal) await options.callJournal.settle(invocationId, outcome);
    if (started) {
      emit(options, {
        type: "tool-execution-end",
        id: use.id,
        name: use.name,
        output: resultContent,
        isError: true,
        durationMs: Date.now() - startedAt,
      });
    }
    return outcome;
  }
}

function emit(options: AgentLoopOptions, event: Parameters<NonNullable<AgentLoopOptions["onToolEvent"]>>[0]): void {
  try { options.onToolEvent?.(event); } catch { /* Observers do not change execution effects. */ }
}

async function runAfterTool(options: AgentLoopOptions, event: Parameters<NonNullable<AgentLoopOptions["afterTool"]>>[0]) {
  try { return await options.afterTool?.(event); }
  catch (error) {
    return { context: [`Post-tool hook failed after execution: ${error instanceof Error ? error.message : String(error)}. Do not repeat the action solely because this hook failed.`] };
  }
}

function appendTextContext(value: string, context: string[] | undefined): string {
  return context?.length ? `${value}\n\nHook context:\n${context.join("\n\n")}` : value;
}

function toolError(toolUseId: string, content: string): ToolResultBlock {
  return { type: "tool-result", toolUseId, content, isError: true };
}
