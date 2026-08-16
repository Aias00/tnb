import { basename, relative, resolve } from "node:path";

import { analyzeShellCommand } from "./shell-permissions";

export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
  "plan",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type PermissionBehavior = "allow" | "deny" | "ask";

export type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
};

export type PermissionRules = {
  allow?: string[];
  deny?: string[];
  ask?: string[];
};

export type ToolPolicy = {
  name: string;
  risk: "read" | "write" | "execute" | "network" | "unknown";
  isReadOnly(input: unknown): boolean;
  requiresApproval?(input: unknown): boolean;
  permissionRuleContent?(input: unknown): string | undefined;
};

export type PermissionEvaluation =
  | { behavior: "allow"; rule?: string }
  | { behavior: "deny"; message: string; rule?: string }
  | { behavior: "ask"; message: string; rule?: string };

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };

export type PermissionPromptDecision = "allow" | "allow-session" | "allow-project" | "deny";

export type PermissionChecker = (
  tool: ToolPolicy,
  input: unknown,
  signal?: AbortSignal,
) => Promise<PermissionDecision>;

export type PermissionOptions = {
  mode: PermissionMode;
  getMode?(): PermissionMode;
  rules?: PermissionRules;
  disableYolo?: boolean;
  cwd?: string;
  trustedFolders?: string[];
  sessionAllowRules?: string[];
  persistPermissionRule?(rule: string): Promise<void>;
  onPermissionRequest?(
    request: PermissionAskRequest,
    signal?: AbortSignal,
  ): Promise<
    | { behavior: "allow"; updatedInput?: unknown }
    | { behavior: "deny"; message: string }
    | { behavior: "ask" }
  >;
  onAsk?(request: PermissionAskRequest, signal?: AbortSignal): Promise<PermissionPromptDecision>;
};

export type PermissionAskRequest = {
  tool: ToolPolicy;
  input: unknown;
  message: string;
  rule?: string;
  suggestedRule?: string;
};

export type ResolvedPermissionMode = {
  mode: PermissionMode;
  reason?: string;
};

export const DANGEROUS_AUTO_EDIT_FILES = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
] as const;

export const DANGEROUS_AUTO_EDIT_DIRECTORIES = [
  ".git",
  ".vscode",
  ".idea",
  ".tnb",
] as const;

export function parsePermissionRule(rule: string): PermissionRuleValue {
  const open = findUnescaped(rule, "(", false);
  if (open < 1) return { toolName: rule };
  const close = findUnescaped(rule, ")", true);
  if (close !== rule.length - 1 || close <= open) return { toolName: rule };
  const rawContent = rule.slice(open + 1, close);
  if (!rawContent || rawContent === "*") return { toolName: rule.slice(0, open) };
  return {
    toolName: rule.slice(0, open),
    ruleContent: rawContent
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\"),
  };
}

export function evaluatePermission(
  options: PermissionOptions,
  tool: ToolPolicy,
  input: unknown,
): PermissionEvaluation {
  const content = tool.permissionRuleContent?.(input);
  const deniedBy = findMatchingRule(options.rules?.deny, tool.name, content, "deny");
  if (deniedBy) {
    return {
      behavior: "deny",
      message: `Permission rule '${deniedBy}' denies ${tool.name}`,
      rule: deniedBy,
    };
  }

  const askedBy = findMatchingRule(options.rules?.ask, tool.name, content, "ask");
  if (askedBy) {
    return {
      behavior: "ask",
      message: `Permission rule '${askedBy}' requires approval for ${tool.name}`,
      rule: askedBy,
    };
  }

  const mode = options.getMode?.() ?? resolvePermissionMode(options).mode;
  const effectiveMode = mode;
  if (tool.requiresApproval?.(input)) {
    return { behavior: "ask", message: `${tool.name} requires approval` };
  }
  if (effectiveMode === "bypassPermissions") return { behavior: "allow" };

  if (tool.isReadOnly(input) && effectiveMode !== "plan") {
    return { behavior: "allow" };
  }

  if (effectiveMode === "plan") {
    return {
      behavior: "deny",
      message: `${tool.name} is unavailable in plan mode`,
    };
  }

  if (tool.risk === "write" && isDangerousAutoEditPath(options, tool, input)) {
    return {
      behavior: "ask",
      message: `${tool.name} requested permission to edit a sensitive file`,
    };
  }

  const allowedBy = findMatchingRule(options.rules?.allow, tool.name, content, "allow");
  if (allowedBy) return { behavior: "allow", rule: allowedBy };

  if (effectiveMode === "auto" && isAutoApproved(options, tool, input)) {
    return { behavior: "allow" };
  }

  if (effectiveMode === "acceptEdits" && tool.risk === "write") {
    return { behavior: "allow" };
  }

  if (effectiveMode === "dontAsk") {
    return {
      behavior: "deny",
      message: `${tool.name} is denied because dontAsk mode cannot prompt`,
    };
  }

  return { behavior: "ask", message: `${tool.name} requires approval` };
}

export function createPermissionChecker(
  options: PermissionOptions,
): PermissionChecker {
  const sessionAllowRules = options.sessionAllowRules ?? [];
  return async (tool, input, signal) => {
    signal?.throwIfAborted();
    const result = evaluatePermission(options, tool, input);
    if (result.behavior === "allow") return { behavior: "allow" };
    if (result.behavior === "deny") {
      return { behavior: "deny", message: result.message };
    }
    const suggestedRule = result.rule || tool.requiresApproval?.(input)
      ? undefined
      : permissionRuleFor(tool, input);
    if (
      !result.rule &&
      sessionAllowRules.length > 0 &&
      findMatchingRule(
        sessionAllowRules,
        tool.name,
        tool.permissionRuleContent?.(input),
        "allow",
      )
    ) {
      return { behavior: "allow" };
    }
    const request: PermissionAskRequest = {
      tool,
      input,
      message: result.message,
      ...(result.rule ? { rule: result.rule } : {}),
      ...(suggestedRule ? { suggestedRule } : {}),
    };
    const hookDecision = await options.onPermissionRequest?.(
      request,
      signal,
    );
    signal?.throwIfAborted();
    if (hookDecision?.behavior === "allow" || hookDecision?.behavior === "deny") {
      return hookDecision;
    }
    if (options.onAsk) {
      const answer = await options.onAsk(
        request,
        signal,
      );
      signal?.throwIfAborted();
      if (answer === "allow-session" && suggestedRule) {
        sessionAllowRules.push(suggestedRule);
        return { behavior: "allow" };
      }
      if (answer === "allow-project" && suggestedRule) {
        if (!options.persistPermissionRule) {
          return { behavior: "deny", message: "Persistent permission updates are unavailable" };
        }
        await options.persistPermissionRule(suggestedRule);
        sessionAllowRules.push(suggestedRule);
        return { behavior: "allow" };
      }
      return answer === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: `User denied permission to use ${tool.name}` };
    }
    return {
      behavior: "deny",
      message: `${tool.name} requires approval, but prompting is unavailable in non-interactive mode`,
    };
  };
}

function permissionRuleFor(tool: ToolPolicy, input: unknown): string {
  const content = tool.permissionRuleContent?.(input);
  if (!content) return tool.name;
  return `${tool.name}(${content.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;
}

export function resolvePermissionMode(
  options: PermissionOptions,
): ResolvedPermissionMode {
  if (options.mode !== "bypassPermissions") return { mode: options.mode };
  if (options.disableYolo) {
    return { mode: "default", reason: "YOLO mode is disabled by settings" };
  }
  if (!options.trustedFolders?.length) return { mode: options.mode };
  if (!options.cwd) {
    return {
      mode: "default",
      reason: "YOLO mode is unavailable outside configured trusted folders",
    };
  }
  const cwd = resolve(options.cwd);
  if (options.trustedFolders.some((folder) => resolve(folder) === cwd)) {
    return { mode: options.mode };
  }
  return {
    mode: "default",
    reason: "YOLO mode is unavailable outside configured trusted folders",
  };
}

const AUTO_APPROVED_WRITE_TOOLS = new Set([
  "write",
  "edit",
  "notebook_edit",
]);

function isAutoApproved(
  options: PermissionOptions,
  tool: ToolPolicy,
  input: unknown,
): boolean {
  const toolName = tool.name.toLowerCase();
  if (toolName === "todo_write" && tool.risk === "write") return true;
  if (tool.risk === "write" && AUTO_APPROVED_WRITE_TOOLS.has(toolName)) {
    const path = tool.permissionRuleContent?.(input);
    return typeof path === "string" && options.cwd !== undefined && isWorkspacePath(options.cwd, path);
  }
  if (toolName !== "bash" || tool.risk !== "execute") return false;
  const command = tool.permissionRuleContent?.(input);
  return typeof command === "string"
    && analyzeShellCommand(command, { cwd: options.cwd }).isSafeAutoApproved;
}

function isWorkspacePath(cwd: string, value: string): boolean {
  if (!value || value.startsWith("-") || /[*?[\]{}~]/.test(value)) return false;
  const target = resolve(cwd, value);
  const rel = relative(resolve(cwd), target);
  return rel === "" || (!rel.startsWith("..") && rel !== "..");
}

function isDangerousAutoEditPath(
  options: PermissionOptions,
  tool: ToolPolicy,
  input: unknown,
): boolean {
  const value = tool.permissionRuleContent?.(input);
  if (!value) return false;
  if (value.startsWith("\\\\") || value.startsWith("//")) return true;
  const absolute = resolve(options.cwd ?? process.cwd(), value);
  const segments = absolute.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (!(DANGEROUS_AUTO_EDIT_DIRECTORIES as readonly string[]).includes(segment)) continue;
    if (segment === ".tnb" && segments[index + 1] === "worktrees") continue;
    return true;
  }
  const fileName = basename(absolute).toLowerCase();
  return (DANGEROUS_AUTO_EDIT_FILES as readonly string[]).includes(fileName);
}

function findMatchingRule(
  rules: string[] | undefined,
  toolName: string,
  content: string | undefined,
  behavior: PermissionBehavior,
): string | undefined {
  return rules?.find((rule) => {
    const parsed = parsePermissionRule(rule);
    if (!toolNameMatches(parsed.toolName, toolName)) return false;
    if (parsed.ruleContent === undefined) return true;
    return (
      content !== undefined &&
      contentMatches(parsed.ruleContent, content, parsed.toolName, behavior)
    );
  });
}

function toolNameMatches(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true;
  if (!pattern.startsWith("mcp__") || !pattern.endsWith("__*")) return false;
  return toolName.startsWith(pattern.slice(0, -1));
}

function contentMatches(
  pattern: string,
  content: string,
  toolName: string,
  behavior: PermissionBehavior,
): boolean {
  const trimmedPattern = pattern.trim();
  const trimmedContent = content.trim();
  if (trimmedPattern.endsWith(":*")) {
    const prefix = trimmedPattern.slice(0, -2);
    if (toolName.toLowerCase() === "bash") {
      if (behavior === "allow" && hasShellOperator(trimmedContent)) return false;
      if (behavior !== "allow") {
        return shellSegments(trimmedContent).some(
          (segment) => segment === prefix || segment.startsWith(`${prefix} `),
        );
      }
    }
    return matchesPrefix(prefix, trimmedContent);
  }
  if (!hasUnescapedWildcard(trimmedPattern)) return trimmedContent === trimmedPattern;
  return wildcardRegex(trimmedPattern).test(trimmedContent);
}

function matchesPrefix(prefix: string, content: string): boolean {
  return content === prefix || content.startsWith(`${prefix} `);
}

function hasShellOperator(command: string): boolean {
  return /&&|\|\||[;|\n]/.test(command);
}

function shellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim().replace(/^\(+\s*/, ""))
    .filter(Boolean);
}

function wildcardRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\" && pattern[index + 1] === "*") {
      source += "\\*";
      index += 1;
    } else if (character === "*") {
      source += ".*";
    } else {
      source += character?.replace(/[.+?^${}()|[\]\\]/g, "\\$&") ?? "";
    }
  }
  return new RegExp(`^${source}$`, "s");
}

function hasUnescapedWildcard(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== "*") continue;
    let slashes = 0;
    for (let previous = index - 1; previous >= 0 && pattern[previous] === "\\"; previous -= 1) {
      slashes += 1;
    }
    if (slashes % 2 === 0) return true;
  }
  return false;
}

function findUnescaped(value: string, character: string, fromEnd: boolean): number {
  const start = fromEnd ? value.length - 1 : 0;
  const end = fromEnd ? -1 : value.length;
  const step = fromEnd ? -1 : 1;
  for (let index = start; index !== end; index += step) {
    if (value[index] !== character) continue;
    let slashes = 0;
    for (let previous = index - 1; previous >= 0 && value[previous] === "\\"; previous -= 1) {
      slashes += 1;
    }
    if (slashes % 2 === 0) return index;
  }
  return -1;
}
