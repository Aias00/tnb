import type { ConversationMessage } from "./message";
import type { PermissionMode } from "./permissions";

export type InferredPlanModeState = {
  mode: PermissionMode;
  prePlanMode?: PermissionMode;
};

export class PermissionModeState {
  private mode: PermissionMode;
  private prePlanMode: PermissionMode | undefined;

  constructor(
    initial: PermissionMode,
    private readonly onChange?: (mode: PermissionMode) => void,
    prePlanMode?: PermissionMode,
  ) {
    this.mode = initial;
    this.prePlanMode = initial === "plan" ? prePlanMode ?? "default" : undefined;
  }

  get current(): PermissionMode {
    return this.mode;
  }

  snapshot(): InferredPlanModeState {
    return {
      mode: this.mode,
      ...(this.mode === "plan" && this.prePlanMode
        ? { prePlanMode: this.prePlanMode }
        : {}),
    };
  }

  enterPlan(): PermissionMode {
    if (this.mode === "plan") throw new Error("Session is already in plan mode");
    this.prePlanMode = this.mode;
    return this.setMode("plan");
  }

  exitPlan(): PermissionMode {
    if (this.mode !== "plan") throw new Error("Cannot exit plan mode because the session is not in plan mode");
    const restore = this.prePlanMode ?? "default";
    this.prePlanMode = undefined;
    return this.setMode(restore);
  }

  private setMode(mode: PermissionMode): PermissionMode {
    this.mode = mode;
    this.onChange?.(mode);
    return mode;
  }
}

export function inferPlanModeState(
  messages: ConversationMessage[],
  initialMode: PermissionMode,
  initialPrePlanMode?: PermissionMode,
): InferredPlanModeState {
  let mode = initialMode;
  let prePlanMode: PermissionMode | undefined = initialMode === "plan"
    ? initialPrePlanMode ?? "default"
    : undefined;
  const toolNames = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "tool-use") toolNames.set(block.id, block.name);
      }
      continue;
    }
    for (const block of message.content) {
      if (block.type !== "tool-result" || block.isError) continue;
      const name = toolNames.get(block.toolUseId);
      if (name === "enter_plan_mode" && mode !== "plan") {
        prePlanMode = mode;
        mode = "plan";
      } else if (name === "exit_plan_mode" && mode === "plan") {
        mode = prePlanMode ?? "default";
        prePlanMode = undefined;
      }
    }
  }

  return {
    mode,
    ...(mode === "plan" && prePlanMode ? { prePlanMode } : {}),
  };
}
