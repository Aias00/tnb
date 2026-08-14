import type { MediaBlock } from "./message";

export type ToolAccess = "read" | "write" | "execute" | "network" | "unknown";

export type ToolOutput =
  | string
  | {
      content: string;
      attachments: MediaBlock[];
    };

export type ToolProgressData = {
  output?: string;
  fullOutput?: string;
  elapsedTimeSeconds?: number;
  totalLines?: number;
  totalBytes?: number;
  timeoutMs?: number;
  taskId?: string;
  progress?: number;
  progressTotal?: number;
  message?: string;
};

export type ToolProgressReporter = (progress: ToolProgressData) => void;

export type ToolDefinition<Input, Output extends ToolOutput = ToolOutput> = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  validate(input: unknown): Input;
  execute(input: Input, signal: AbortSignal, onProgress?: ToolProgressReporter): Promise<Output>;
  access?: ToolAccess;
  isReadOnly?(input: Input): boolean;
  isConcurrencySafe?(input: Input): boolean;
  requiresApproval?(input: Input): boolean;
  permissionRuleContent?(input: Input): string | undefined;
};

export type AgentTool<Output extends ToolOutput = ToolOutput> = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  validate(input: unknown): unknown;
  execute(input: unknown, signal: AbortSignal, onProgress?: ToolProgressReporter): Promise<Output>;
  access: ToolAccess;
  isReadOnly(input: unknown): boolean;
  isConcurrencySafe(input: unknown): boolean;
  requiresApproval?(input: unknown): boolean;
  permissionRuleContent?(input: unknown): string | undefined;
};

export function defineTool<Input, Output extends ToolOutput = string>(
  definition: ToolDefinition<Input, Output>,
): AgentTool<Output> {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    validate: definition.validate,
    execute: (input, signal, onProgress) => definition.execute(input as Input, signal, onProgress),
    access: definition.access ?? "unknown",
    isReadOnly: definition.isReadOnly
      ? (input) => definition.isReadOnly?.(input as Input) ?? false
      : () => false,
    isConcurrencySafe: definition.isConcurrencySafe
      ? (input) => definition.isConcurrencySafe?.(input as Input) ?? false
      : () => false,
    ...(definition.requiresApproval
      ? {
          requiresApproval: (input: unknown) =>
            definition.requiresApproval?.(input as Input) ?? false,
        }
      : {}),
    ...(definition.permissionRuleContent
      ? {
          permissionRuleContent: (input: unknown) =>
            definition.permissionRuleContent?.(input as Input),
        }
      : {}),
  };
}
