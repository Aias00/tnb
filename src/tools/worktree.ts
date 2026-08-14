import { defineTool, type AgentTool } from "../core/tool";
import { WorkspaceState } from "../core/workspace-state";
import type { WorktreeSessionState } from "../core/workspace-state";
import { CheckpointManager } from "../services/checkpoint/manager";
import { ShellSessionManager } from "../services/shell/manager";
import {
  createSessionWorktree,
  inspectWorktree,
  removeSessionWorktree,
  validateWorktreeName,
} from "../services/worktree/manager";

export function createWorkspaceTools(options: {
  workspace: WorkspaceState;
  shell: ShellSessionManager;
  checkpoints: CheckpointManager;
  onWorktreeChange?(state: WorktreeSessionState | null): Promise<void>;
  beforeWorktreeCreate?(name: string): Promise<void>;
  beforeWorktreeRemove?(state: WorktreeSessionState): Promise<void>;
  onCwdChanged?(oldCwd: string, newCwd: string): Promise<void>;
}): AgentTool[] {
  const { workspace, shell, checkpoints } = options;
  return [
    defineTool<{ name: string }>({
      name: "enter_worktree",
      description: "Create or reopen an isolated Git worktree and switch this session into it.",
      inputSchema: objectSchema({
        name: { type: "string", description: "Worktree name; 1-64 safe path characters." },
      }, ["name"]),
      access: "write",
      permissionRuleContent: ({ name }) => name,
      validate(input) {
        const value = requireObject(input);
        if (typeof value.name !== "string") throw new Error("enter_worktree requires name");
        return { name: validateWorktreeName(value.name) };
      },
      async execute({ name }) {
        if (workspace.worktree) throw new Error("This session is already using an isolated worktree");
        const oldCwd = workspace.current();
        await options.beforeWorktreeCreate?.(name);
        const state = await createSessionWorktree(workspace.current(), name);
        workspace.enter(state);
        shell.setCwd(state.worktreePath);
        await options.onWorktreeChange?.(state);
        await options.onCwdChanged?.(oldCwd, state.worktreePath);
        return `Session switched to worktree ${state.worktreePath} on branch ${state.worktreeBranch}.`;
      },
    }),
    defineTool<{ action: "keep" | "remove"; discardChanges: boolean }>({
      name: "exit_worktree",
      description: "Leave the worktree created by this session. Keep it, or explicitly remove it.",
      inputSchema: objectSchema({
        action: { type: "string", enum: ["keep", "remove"] },
        discard_changes: { type: "boolean", description: "Required to remove a worktree containing changes or commits." },
      }, ["action"]),
      access: "write",
      requiresApproval: ({ action }) => action === "remove",
      permissionRuleContent: ({ action }) => action,
      validate(input) {
        const value = requireObject(input);
        if (value.action !== "keep" && value.action !== "remove") throw new Error("exit_worktree action must be keep or remove");
        if (value.discard_changes !== undefined && typeof value.discard_changes !== "boolean") {
          throw new Error("discard_changes must be boolean");
        }
        return { action: value.action, discardChanges: value.discard_changes === true };
      },
      async execute(input) {
        const state = workspace.worktree;
        if (!state) throw new Error("This session has no active worktree");
        const summary = await inspectWorktree(state);
        if (input.action === "remove" && (summary.changedFiles || summary.commits) && !input.discardChanges) {
          throw new Error(`Worktree contains ${summary.changedFiles} changed files and ${summary.commits} commits; set discard_changes=true after confirming removal`);
        }
        if (input.action === "remove") await options.beforeWorktreeRemove?.(state);
        const oldCwd = workspace.current();
        workspace.exit();
        shell.setCwd(workspace.current());
        if (input.action === "remove") await removeSessionWorktree(state);
        await options.onWorktreeChange?.(null);
        await options.onCwdChanged?.(oldCwd, workspace.current());
        return input.action === "keep"
          ? `Returned to ${workspace.current()}. Worktree preserved at ${state.worktreePath}.`
          : `Returned to ${workspace.current()} and removed ${state.worktreePath}.`;
      },
    }),
    defineTool<{ label: string }>({
      name: "checkpoint_create",
      description: "Create a restorable local checkpoint of all tracked and non-ignored workspace files without changing the working tree or stash list.",
      inputSchema: objectSchema({ label: { type: "string", description: "Short checkpoint label." } }, []),
      access: "write",
      validate(input) {
        const value = requireObject(input);
        if (value.label !== undefined && typeof value.label !== "string") throw new Error("checkpoint label must be a string");
        return { label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : "Manual checkpoint" };
      },
      async execute({ label }) {
        const record = await checkpoints.create(workspace.current(), label);
        return `Created checkpoint ${record.id}: ${record.label}`;
      },
    }),
    defineTool<Record<string, never>>({
      name: "checkpoint_list",
      description: "List restorable checkpoints for the current Git workspace.",
      inputSchema: objectSchema({}, []),
      access: "read",
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      validate(input) {
        requireObject(input);
        return {};
      },
      async execute() {
        const records = await checkpoints.list(workspace.current());
        return records.length
          ? records.map((record) => `${record.id}\t${record.createdAt}\t${record.label}`).join("\n")
          : "No checkpoints found";
      },
    }),
    defineTool<{ id: string; force: boolean }>({
      name: "checkpoint_rollback",
      description: "Restore tracked and non-ignored files plus staged state to a checkpoint. Ignored files are left untouched.",
      inputSchema: objectSchema({
        id: { type: "string", description: "Checkpoint id from checkpoint_list." },
        force: { type: "boolean", description: "Allow rollback when HEAD changed since checkpoint creation." },
      }, ["id"]),
      access: "write",
      requiresApproval: () => true,
      permissionRuleContent: ({ id }) => id,
      validate(input) {
        const value = requireObject(input);
        if (typeof value.id !== "string" || !value.id.trim()) throw new Error("checkpoint_rollback requires id");
        if (value.force !== undefined && typeof value.force !== "boolean") throw new Error("force must be boolean");
        return { id: value.id.trim(), force: value.force === true };
      },
      async execute({ id, force }) {
        const record = await checkpoints.rollback(workspace.current(), id, force);
        return `Restored checkpoint ${record.id}: ${record.label}`;
      },
    }),
  ];
}

function requireObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("tool input must be an object");
  return input as Record<string, unknown>;
}

function objectSchema(properties: Record<string, Record<string, unknown>>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
