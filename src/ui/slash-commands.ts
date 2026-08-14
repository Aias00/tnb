import type { TranscriptEntry } from "./transcript/model";

export const SLASH_COMMANDS = [
  {
    name: "help",
    aliases: ["?"] as const,
    usage: "/help",
    description: "Show available interactive commands.",
  },
  {
    name: "about",
    aliases: [] as const,
    usage: "/about",
    description: "Show tnb, runtime, model, and workspace information.",
  },
  {
    name: "reload",
    aliases: ["refresh"] as const,
    usage: "/reload",
    description: "Reload extensions and reconnect MCP servers.",
  },
  {
    name: "doctor",
    aliases: ["diagnostics"] as const,
    usage: "/doctor",
    description: "Validate providers, settings, MCP configuration, tools, and credentials.",
  },
  {
    name: "feedback",
    aliases: ["bug"] as const,
    usage: "/feedback <comment>",
    description: "Submit feedback through the configured feedback endpoint.",
  },
  {
    name: "model",
    aliases: [] as const,
    usage: "/model [provider/model | model]",
    description: "Show or switch the active model.",
  },
  {
    name: "models",
    aliases: [] as const,
    usage: "/models",
    description: "List configured providers and models.",
  },
  {
    name: "effort",
    aliases: [] as const,
    usage: "/effort [off|minimal|low|medium|high|xhigh]",
    description: "Show or change reasoning effort for later turns.",
  },
  {
    name: "fast",
    aliases: [] as const,
    usage: "/fast [on|off]",
    description: "Toggle Anthropic fast inference without changing models.",
  },
  {
    name: "btw",
    aliases: [] as const,
    usage: "/btw <question>",
    description: "Ask one tool-free side question without changing the main conversation.",
  },
  {
    name: "plan",
    aliases: [] as const,
    usage: "/plan [on|off]",
    description: "Toggle read-only Plan Mode.",
  },
  {
    name: "settings",
    aliases: ["config"] as const,
    usage: "/settings [get <key>|set <key> <json>|unset <key>]",
    description: "Inspect or edit user settings.",
  },
  {
    name: "context-window",
    aliases: [] as const,
    usage: "/context-window [default|tokens]",
    description: "Show or override the active context limit for compaction.",
  },
  {
    name: "editor",
    aliases: [] as const,
    usage: "/editor [command]",
    description: "Show or set the preferred external editor.",
  },
  {
    name: "docs",
    aliases: [] as const,
    usage: "/docs",
    description: "Show the configured documentation location.",
  },
  {
    name: "release-notes",
    aliases: [] as const,
    usage: "/release-notes",
    description: "Show release notes information for this build.",
  },
  {
    name: "add-dir",
    aliases: [] as const,
    usage: "/add-dir <directory>",
    description: "Add another approved directory to this session's workspace context.",
  },
  {
    name: "directories",
    aliases: ["workspace", "list"] as const,
    usage: "/directories",
    description: "List directories in the current workspace context.",
  },
  {
    name: "profile",
    aliases: [] as const,
    usage: "/profile",
    description: "Show the effective local runtime profile.",
  },
  {
    name: "privacy",
    aliases: [] as const,
    usage: "/privacy",
    description: "Show local data and external-service boundaries.",
  },
  {
    name: "shortcuts",
    aliases: [] as const,
    usage: "/shortcuts",
    description: "Show interactive keyboard shortcuts.",
  },
  {
    name: "tools",
    aliases: [] as const,
    usage: "/tools",
    description: "List built-in, plugin, and connected MCP tools.",
  },
  {
    name: "workflows",
    aliases: ["workflow-tasks"] as const,
    usage: "/workflows [list|definition <name>|run <run-id>]",
    description: "Browse saved workflow definitions and persisted runs.",
  },
  {
    name: "permissions",
    aliases: ["permission"] as const,
    usage: "/permissions [default|acceptEdits|auto|dontAsk|plan|yolo]",
    description: "Show or change the permission mode.",
  },
  {
    name: "status",
    aliases: [] as const,
    usage: "/status",
    description: "Show the active runtime and session.",
  },
  {
    name: "memory",
    aliases: ["manage"] as const,
    usage: "/memory [show|on|off]",
    description: "View or configure persistent project memory.",
  },
  {
    name: "mcp",
    aliases: [] as const,
    usage: "/mcp [show|enable|disable|remove|reload] [server]",
    description: "Inspect or manage configured MCP servers.",
  },
  {
    name: "rewind",
    aliases: ["checkpoint"] as const,
    usage: "/rewind [turns]",
    description: "Rewind conversation history by one or more user turns.",
  },
  {
    name: "rollback",
    aliases: [] as const,
    usage: "/rollback [checkpoint-id] [--files-only] [--force]",
    description: "Restore a workspace checkpoint and its linked conversation boundary.",
  },
  {
    name: "diff",
    aliases: [] as const,
    usage: "/diff",
    description: "Show current Git working-tree changes.",
  },
  {
    name: "context",
    aliases: [] as const,
    usage: "/context",
    description: "Show estimated conversation context usage.",
  },
  {
    name: "usage",
    aliases: ["cost"] as const,
    usage: "/usage",
    description: "Show persisted token and cost totals for this session.",
  },
  {
    name: "insights",
    aliases: [] as const,
    usage: "/insights",
    description: "Summarize local workspace sessions, messages, token use, and cost.",
  },
  {
    name: "crontab",
    aliases: ["cron"] as const,
    usage: "/crontab [remove <id>]",
    description: "Browse or remove scheduled Agent prompts.",
  },
  {
    name: "upgrade",
    aliases: ["update"] as const,
    usage: "/upgrade",
    description: "Check the configured release channel for a newer tnb build.",
  },
  {
    name: "copy",
    aliases: [] as const,
    usage: "/copy",
    description: "Copy the latest assistant response with OSC 52.",
  },
  {
    name: "vim",
    aliases: [] as const,
    usage: "/vim [on|off]",
    description: "Show or change Vim-style input mode.",
  },
  {
    name: "theme",
    aliases: [] as const,
    usage: "/theme [magenta|cyan|blue|green]",
    description: "Show or change the terminal accent theme.",
  },
  {
    name: "goal",
    aliases: [] as const,
    usage: "/goal [set <objective> [--turns N]|status|pause|resume|clear]",
    description: "Manage the persistent goal for this session.",
  },
  {
    name: "agents",
    aliases: [] as const,
    usage: "/agents [name]",
    description: "List available built-in and custom agents.",
  },
  {
    name: "team",
    aliases: ["teams"] as const,
    usage: "/team",
    description: "Inspect the current Agent Team and teammate state.",
  },
  {
    name: "tasks",
    aliases: ["jobs"] as const,
    usage: "/tasks",
    description: "Inspect persistent work items and background Agent tasks.",
  },
  {
    name: "checkpoints",
    aliases: [] as const,
    usage: "/checkpoints",
    description: "Browse workspace checkpoints available for rollback.",
  },
  {
    name: "skills",
    aliases: [] as const,
    usage: "/skills [name|reload]",
    description: "Browse loaded Skills and their tool policy.",
  },
  {
    name: "plugins",
    aliases: [] as const,
    usage: "/plugins [enable|disable|trust|untrust|update|remove <name>|reload]",
    description: "Browse, update, remove, toggle, and reload local capability plugins.",
  },
  {
    name: "marketplace",
    aliases: ["market"] as const,
    usage: "/marketplace [search text|install name]",
    description: "Browse configured plugin marketplaces and install plugins.",
  },
  {
    name: "security",
    aliases: ["security-review"] as const,
    usage: "/security [all|staged]",
    description: "Run and inspect the local security review.",
  },
  {
    name: "security-settings",
    aliases: [] as const,
    usage: "/security-settings [yolo on|off|trust <directory>|untrust <directory>]",
    description: "Inspect or update local YOLO and trusted-workspace policy.",
  },
  {
    name: "ide",
    aliases: [] as const,
    usage: "/ide",
    description: "Inspect local IDE bridge discovery endpoints.",
  },
  {
    name: "hooks",
    aliases: [] as const,
    usage: "/hooks [event:index:index]",
    description: "Browse effective lifecycle Hook handlers.",
  },
  {
    name: "commands",
    aliases: [] as const,
    usage: "/commands",
    description: "List custom prompt commands.",
  },
  {
    name: "sessions",
    aliases: [] as const,
    usage: "/sessions [search]",
    description: "List recent sessions for this workspace.",
  },
  {
    name: "rename",
    aliases: [] as const,
    usage: "/rename <title>",
    description: "Set a human-readable title for the current session.",
  },
  {
    name: "fork",
    aliases: ["branch"] as const,
    usage: "/fork [title]",
    description: "Fork the current conversation into a new session.",
  },
  {
    name: "session-rename",
    aliases: [] as const,
    usage: "/session-rename <session-id> <title>",
    description: "Rename a selected session from the session browser.",
  },
  {
    name: "session-fork",
    aliases: [] as const,
    usage: "/session-fork <session-id> [title]",
    description: "Fork a selected session from the session browser.",
  },
  {
    name: "session-delete",
    aliases: [] as const,
    usage: "/session-delete <session-id> [--confirm]",
    description: "Delete a selected inactive session after confirmation.",
  },
  {
    name: "resume",
    aliases: [] as const,
    usage: "/resume [session-id | prefix]",
    description: "Show sessions or switch to a previous session.",
  },
  {
    name: "continue",
    aliases: [] as const,
    usage: "/continue",
    description: "Switch to the most recently modified other session.",
  },
  {
    name: "export",
    aliases: [] as const,
    usage: "/export [filename]",
    description: "Export the current conversation as plain text.",
  },
  {
    name: "compact",
    aliases: ["compress", "summarize"] as const,
    usage: "/compact",
    description: "Summarize and compact the current session now.",
  },
  {
    name: "clear",
    aliases: ["new"] as const,
    usage: "/clear",
    description: "Clear the display and start a new session.",
  },
  {
    name: "exit",
    aliases: ["quit"] as const,
    usage: "/exit",
    description: "Exit tnb.",
  },
] as const;

export type SlashCommandName = (typeof SLASH_COMMANDS)[number]["name"];

export type ParsedSlashCommand = {
  name: SlashCommandName;
  invokedAs: string;
  argument: string;
};

export type SlashCommandParseResult =
  | { kind: "command"; command: ParsedSlashCommand }
  | { kind: "unknown"; name: string }
  | { kind: "text" };

export type SlashCommandRequest = ParsedSlashCommand & {
  sessionId: string;
  nextSessionId: string;
};

export type SlashCommandResult = {
  message?: string;
  model?: string;
  contextWindowTokens?: number;
  permissionMode?: "default" | "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk" | "plan";
  resetSession?: boolean;
  sessionId?: string;
  resumeSession?: boolean;
  restoredMessages?: Array<
    | { role: "user" | "assistant"; text: string }
    | { role: "system"; text: string; tone: "info" | "error" }
  >;
  restoredTranscript?: TranscriptEntry[];
  restoredInputHistory?: string[];
  management?: ManagementView;
  clipboardText?: string;
  vimMode?: boolean;
  theme?: "magenta" | "cyan" | "blue" | "green";
};

export type ManagementView = {
  kind: "sessions" | "models" | "permissions" | "mcp" | "checkpoints" | "tasks" | "crontab" | "workflows" | "skills" | "plugins" | "marketplace" | "security" | "doctor" | "ide" | "hooks" | "agents" | "team";
  title: string;
  description?: string;
  items: ManagementItem[];
};

export type ManagementItem = {
  id: string;
  label: string;
  description?: string;
  preview?: string[];
  transcriptPreview?: TranscriptEntry[];
  command: string;
  active?: boolean;
  badges?: string[];
  details?: string[];
  inspectCommand?: string;
  inspectLabel?: string;
};

export type ExternalSlashCommand = {
  name: string;
  usage: string;
  description: string;
};

export function parseSlashCommand(input: string): SlashCommandParseResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { kind: "text" };
  const separator = trimmed.search(/\s/);
  const invokedAs = trimmed.slice(1, separator < 0 ? undefined : separator);
  const argument = separator < 0 ? "" : trimmed.slice(separator).trim();
  const normalized = invokedAs.toLowerCase();
  const definition = SLASH_COMMANDS.find(
    (command) => command.name === normalized || command.aliases.some((alias) => alias === normalized),
  );
  return definition
    ? {
        kind: "command",
        command: { name: definition.name, invokedAs, argument },
      }
    : { kind: "unknown", name: invokedAs };
}

export function slashCommandHelp(external: readonly ExternalSlashCommand[] = []): string {
  const commands = [...SLASH_COMMANDS, ...external];
  const width = Math.max(...commands.map(({ usage }) => usage.length));
  return [
    "Interactive commands",
    "",
    ...commands.map(
      ({ usage, description }) => `${usage.padEnd(width)}  ${description}`,
    ),
  ].join("\n");
}

export function suggestSlashCommands(
  input: string,
  external: readonly ExternalSlashCommand[] = [],
): Array<(typeof SLASH_COMMANDS)[number] | ExternalSlashCommand> {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/") || trimmed.includes(" ")) return [];
  const query = trimmed.slice(1).toLowerCase();
  return [...SLASH_COMMANDS, ...external].filter(
    (command) =>
      command.name.startsWith(query) || ("aliases" in command && command.aliases.some((alias) => alias.startsWith(query))),
  ).slice(0, 8);
}
