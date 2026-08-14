type Writer = { write(text: string): unknown };

const COMMANDS = [
  "agents", "completion", "config", "doctor", "goal-loop", "goal-loop-stop", "hooks", "jobs",
  "feedback", "mcp", "models", "plugins", "provider", "remote-control", "rollback", "security-scan",
  "sessions", "skills", "status", "update",
] as const;
const PROVIDER_ACTIONS = ["list", "show", "add", "set", "use", "test", "remove", "model"] as const;
const MCP_ACTIONS = ["list", "show", "add", "remove", "enable", "disable", "auth", "logout", "tools", "prompts", "resources", "templates", "complete"] as const;

export function runCompletionCommand(options: { argv: string[]; stdout: Writer; stderr: Writer }): number {
  const shell = options.argv[1];
  if (shell === "bash") options.stdout.write(bashCompletion());
  else if (shell === "zsh") options.stdout.write(zshCompletion());
  else if (shell === "fish") options.stdout.write(fishCompletion());
  else {
    options.stderr.write("tnb: completion requires bash, zsh, or fish\n");
    return 1;
  }
  return 0;
}

function bashCompletion(): string {
  return `# tnb bash completion
_tnb_completion() {
  local current previous command
  current="\${COMP_WORDS[COMP_CWORD]}"
  previous="\${COMP_WORDS[COMP_CWORD-1]}"
  command="\${COMP_WORDS[1]}"
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W '${COMMANDS.join(" ")} --help --version --provider --model --permission-mode --sandbox --yolo --dangerously-skip-permissions --add-dir --session-id --fork-session --name --mcp-config --strict-mcp-config --settings --agents --agent --tools --system-prompt-file --append-system-prompt-file' -- "\${current}") )
    return
  fi
  case "\${command}" in
    completion) COMPREPLY=( $(compgen -W 'bash zsh fish' -- "\${current}") ) ;;
    provider)
      if [[ \${COMP_CWORD} -eq 2 ]]; then COMPREPLY=( $(compgen -W '${PROVIDER_ACTIONS.join(" ")}' -- "\${current}") ); fi ;;
    mcp)
      if [[ \${COMP_CWORD} -eq 2 ]]; then COMPREPLY=( $(compgen -W '${MCP_ACTIONS.join(" ")}' -- "\${current}") ); fi ;;
    plugins) COMPREPLY=( $(compgen -W 'list show marketplace search install update remove enable disable --marketplace --project --yes --json' -- "\${current}") ) ;;
    skills) COMPREPLY=( $(compgen -W 'list show install remove --project --yes --json' -- "\${current}") ) ;;
    sessions) COMPREPLY=( $(compgen -W 'list show delete --yes --json' -- "\${current}") ) ;;
    jobs) COMPREPLY=( $(compgen -W 'list show rm --yes --discard-changes --json' -- "\${current}") ) ;;
  esac
}
complete -F _tnb_completion tnb
`;
}

function zshCompletion(): string {
  return `#compdef tnb
_tnb() {
  local -a commands
  commands=(
${COMMANDS.map((command) => `    '${command}:${command.replaceAll("-", " ")}'`).join("\n")}
  )
  _arguments -C \\
    '(-h --help)'{-h,--help}'[show help]' \\
    '(-V --version)'{-V,--version}'[show version]' \\
    '1:command:->command' \\
    '*::argument:->args'
  case $state in
    command) _describe 'command' commands ;;
    args)
      case $words[2] in
        completion) _values 'shell' bash zsh fish ;;
        provider) _values 'provider action' ${PROVIDER_ACTIONS.join(" ")} ;;
        mcp) _values 'MCP action' ${MCP_ACTIONS.join(" ")} ;;
        plugins) _values 'plugin action' list show marketplace search install update remove enable disable ;;
        skills) _values 'Skill action' list show install remove ;;
        sessions) _values 'session action' list show delete ;;
        jobs) _values 'job action' list show rm ;;
      esac ;;
  esac
}
_tnb "$@"
`;
}

function fishCompletion(): string {
  const lines = [
    "# tnb fish completion",
    "complete -c tnb -f",
    ...COMMANDS.map((command) => `complete -c tnb -n '__fish_use_subcommand' -a '${command}'`),
    "complete -c tnb -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'",
    `complete -c tnb -n '__fish_seen_subcommand_from provider' -a '${PROVIDER_ACTIONS.join(" ")}'`,
    `complete -c tnb -n '__fish_seen_subcommand_from mcp' -a '${MCP_ACTIONS.join(" ")}'`,
    "complete -c tnb -s h -l help -d 'Show help'",
    "complete -c tnb -s V -l version -d 'Show version'",
    "complete -c tnb -l provider -r -d 'Provider id'",
    "complete -c tnb -l model -r -d 'Model id'",
    "complete -c tnb -l agent -r -d 'Main-thread Agent profile'",
    "complete -c tnb -l permission-mode -r -a 'default acceptEdits auto dontAsk plan yolo'",
  ];
  return `${lines.join("\n")}\n`;
}
