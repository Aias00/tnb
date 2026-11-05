export const CLI_COMMANDS = [
  "agents", "collaboration", "completion", "config", "continue", "doctor", "feedback", "goal-loop", "goal-loop-stop",
  "help", "hooks", "ide", "jobs", "mcp", "models", "plugins", "provider", "providers",
  "remote-control", "resume", "rm", "rollback", "runtime", "security-scan", "sessions", "skills", "status", "update", "web",
] as const;

export function isUnknownCliCommand(argv: readonly string[]): boolean {
  const first = argv[0];
  return Boolean(first && !first.startsWith("-") && !(CLI_COMMANDS as readonly string[]).includes(first));
}

export const SIMPLE_COMMAND_HELP: Record<string, string> = {
  models: "tnb models [--json] [--output-format text|json]",
  status: "tnb status [--json]",
  doctor: "tnb doctor [--json]",
  completion: "tnb completion <bash|zsh|fish>",
  skills: "tnb skills [list|show <name>|install <dir>|remove <name> --yes] [--project] [--json]",
  agents: "tnb agents [--json]",
  hooks: "tnb hooks [--json]",
  plugins: "tnb plugins [list|show|marketplace|search|install|update|remove|enable|disable|trust|untrust] [name] [--project] [--yes]",
};
