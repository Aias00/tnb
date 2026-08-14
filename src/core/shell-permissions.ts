import { basename, relative, resolve } from "node:path";

export type ShellFamily = "posix" | "powershell";

export type ShellInvocation = {
  family: ShellFamily;
  file: string;
  args(command: string): string[];
};

export type ShellSegmentAnalysis = {
  command: string;
  executable?: string;
  args: string[];
  isReadOnly: boolean;
  isSafeAutoApproved: boolean;
};

export type ShellCommandAnalysis = {
  family: ShellFamily;
  normalizedCommand: string;
  operators: string[];
  segments: ShellSegmentAnalysis[];
  hasRedirection: boolean;
  hasBackgrounding: boolean;
  hasCommandSubstitution: boolean;
  isReadOnly: boolean;
  isSafeAutoApproved: boolean;
};

type ScanState = {
  current: string;
  operators: string[];
  segments: string[];
  hasRedirection: boolean;
  hasBackgrounding: boolean;
  hasCommandSubstitution: boolean;
  invalid: boolean;
};

const POSIX_READ_ONLY = new Set([
  "[",
  "basename",
  "cat",
  "command",
  "cut",
  "dirname",
  "echo",
  "env",
  "fd",
  "file",
  "find",
  "git",
  "grep",
  "head",
  "ls",
  "namei",
  "nl",
  "printenv",
  "printf",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "sed",
  "sort",
  "stat",
  "tail",
  "test",
  "tree",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
  "xargs",
]);

const POWER_SHELL_ALIAS_MAP = new Map<string, string>([
  ["cat", "get-content"],
  ["dir", "get-childitem"],
  ["echo", "write-output"],
  ["gci", "get-childitem"],
  ["gc", "get-content"],
  ["gl", "get-location"],
  ["iex", "invoke-expression"],
  ["ls", "get-childitem"],
  ["pwd", "get-location"],
  ["select", "select-object"],
  ["sort", "sort-object"],
  ["type", "get-content"],
]);

const POSIX_SHELL_EXECUTABLES = new Set([
  "bash",
  "dash",
  "ksh",
  "sh",
  "zsh",
]);

const POWERSHELL_EXECUTABLES = new Set([
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "blame",
  "branch",
  "describe",
  "diff",
  "grep",
  "log",
  "ls-files",
  "remote",
  "rev-parse",
  "show",
  "status",
  "tag",
]);

const SAFE_POSIX_WRITE_FLAGS = {
  cp: new Set(["-R", "-r", "-f", "-n", "-p"]),
  mkdir: new Set(["-p"]),
  mv: new Set(["-f", "-n"]),
  touch: new Set(["-c"]),
};

const SAFE_POWERSHELL_WRITE_FLAGS = {
  "copy-item": new Set(["-force"]),
  "move-item": new Set(["-force"]),
  "new-item": new Set(["-force", "-itemtype"]),
  "rename-item": new Set(["-force"]),
};

export function resolveShellInvocation(
  env: Record<string, string | undefined>,
  platformName = process.platform,
): ShellInvocation {
  const configured = env.TNB_SHELL ?? env.SHELL;
  if (configured) {
    const family = detectShellFamily(configured, platformName);
    return family === "powershell"
      ? {
          family,
          file: configured,
          args: (command) => ["-NoLogo", "-NoProfile", "-Command", command],
        }
      : {
          family,
          file: configured,
          args: (command) => ["-lc", command],
        };
  }

  if (platformName === "win32") {
    const file = env.TNB_POWERSHELL ?? env.PWSH ?? "powershell.exe";
    return {
      family: "powershell",
      file,
      args: (command) => ["-NoLogo", "-NoProfile", "-Command", command],
    };
  }

  return {
    family: "posix",
    file: "/bin/zsh",
    args: (command) => ["-lc", command],
  };
}

export function analyzeShellCommand(
  command: string,
  options: {
    cwd?: string;
    family?: ShellFamily;
  } = {},
): ShellCommandAnalysis {
  const normalizedCommand = command.trim();
  const family = options.family ?? "posix";
  if (!normalizedCommand) {
    return {
      family,
      normalizedCommand,
      operators: [],
      segments: [],
      hasRedirection: false,
      hasBackgrounding: false,
      hasCommandSubstitution: false,
      isReadOnly: false,
      isSafeAutoApproved: false,
    };
  }

  const scan = scanShellCommand(normalizedCommand, family);
  const segments = scan.segments
    .map((segment) => analyzeShellSegment(segment, family, options.cwd))
    .filter((segment) => segment.command.length > 0);
  const isReadOnly = !scan.invalid
    && !scan.hasRedirection
    && !scan.hasBackgrounding
    && !scan.hasCommandSubstitution
    && segments.length > 0
    && segments.every((segment) => segment.isReadOnly);
  const isSafeAutoApproved = !scan.invalid
    && !scan.hasRedirection
    && !scan.hasBackgrounding
    && !scan.hasCommandSubstitution
    && segments.length > 0
    && scan.operators.every((operator) => operator === "&&" || operator === ";" || operator === "\n")
    && segments.every((segment) => segment.isSafeAutoApproved);

  return {
    family,
    normalizedCommand,
    operators: scan.operators,
    segments,
    hasRedirection: scan.hasRedirection,
    hasBackgrounding: scan.hasBackgrounding,
    hasCommandSubstitution: scan.hasCommandSubstitution,
    isReadOnly,
    isSafeAutoApproved,
  };
}

function detectShellFamily(configured: string, platformName: string): ShellFamily {
  const name = basename(configured).toLowerCase();
  if (name.includes("pwsh") || name.includes("powershell")) return "powershell";
  if (platformName === "win32" && (name === "bash.exe" || name === "zsh.exe" || name === "sh.exe")) {
    return "posix";
  }
  return "posix";
}

function scanShellCommand(command: string, family: ShellFamily): ScanState {
  const state: ScanState = {
    current: "",
    operators: [],
    segments: [],
    hasRedirection: false,
    hasBackgrounding: false,
    hasCommandSubstitution: false,
    invalid: false,
  };
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  const escapeCharacter = family === "powershell" ? "`" : "\\";

  const pushSegment = () => {
    const trimmed = state.current.trim();
    if (trimmed) state.segments.push(trimmed);
    state.current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    const next = command[index + 1];

    if (escaped) {
      state.current += char;
      escaped = false;
      continue;
    }
    if (char === escapeCharacter && quote !== "'") {
      state.current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      state.current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      state.current += char;
      continue;
    }
    if (isNonAsciiWhitespace(char)) {
      state.invalid = true;
      state.current += char;
      continue;
    }
    if (char === "$" && next === "(") {
      state.hasCommandSubstitution = true;
      state.current += "$(";
      parenDepth += 1;
      index += 1;
      continue;
    }
    if (family === "posix" && char === "`") {
      state.hasCommandSubstitution = true;
      state.current += char;
      continue;
    }
    if (family === "powershell" && isPowerShellSplatStart(command, index)) {
      state.invalid = true;
      state.current += char;
      continue;
    }

    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);

    const topLevel = parenDepth === 0 && braceDepth === 0 && bracketDepth === 0;
    if (!topLevel) {
      state.current += char;
      continue;
    }

    if ((char === ">" || char === "<")) {
      state.hasRedirection = true;
      state.current += char;
      if (next === char || (char === ">" && next === "|")) {
        state.current += next;
        index += 1;
      }
      continue;
    }
    if (char === "\n") {
      pushSegment();
      state.operators.push("\n");
      continue;
    }
    if ((char === "&" || char === "|") && next === char) {
      pushSegment();
      state.operators.push(`${char}${next}`);
      index += 1;
      continue;
    }
    if (char === ";" || char === "|") {
      pushSegment();
      state.operators.push(char);
      continue;
    }
    if (char === "&") {
      if (family === "posix") {
        state.hasBackgrounding = true;
        pushSegment();
        state.operators.push("&");
        continue;
      }
    }

    state.current += char;
  }

  if (quote || escaped || parenDepth !== 0 || braceDepth !== 0 || bracketDepth !== 0) state.invalid = true;
  pushSegment();
  return state;
}

function analyzeShellSegment(command: string, family: ShellFamily, cwd?: string): ShellSegmentAnalysis {
  const tokens = splitShellWords(command, family);
  const commandTokens = family === "posix" ? stripPosixAssignments(tokens) : tokens;
  const executable = normalizeExecutable(commandTokens[0], family);
  const args = commandTokens.slice(1);
  const isReadOnly = executable !== undefined && isReadOnlyExecutable(executable, args, family);
  const isSafeAutoApproved = executable !== undefined && cwd !== undefined
    && isSafeAutoApprovedExecutable(executable, args, family, cwd);

  return {
    command,
    ...(executable === undefined ? {} : { executable }),
    args,
    isReadOnly,
    isSafeAutoApproved,
  };
}

function splitShellWords(command: string, family: ShellFamily): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const escapeCharacter = family === "powershell" ? "`" : "\\";

  const pushWord = () => {
    if (!current) return;
    words.push(current);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === escapeCharacter && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (isNonAsciiWhitespace(char)) {
      pushWord();
      continue;
    }
    if (isAsciiWhitespace(char)) {
      pushWord();
      continue;
    }
    current += char;
  }
  pushWord();
  return words;
}

function normalizeExecutable(executable: string | undefined, family: ShellFamily): string | undefined {
  if (!executable) return undefined;
  const lowered = basename(executable).toLowerCase();
  if (family === "powershell") return POWER_SHELL_ALIAS_MAP.get(lowered) ?? lowered;
  return lowered;
}

function isReadOnlyExecutable(executable: string, args: string[], family: ShellFamily): boolean {
  if (isNestedShellExecutable(executable, args, family)) return false;
  if (executable === "git") return isReadOnlyGit(args);
  if (family === "powershell") return isReadOnlyPowerShellExecutable(executable, args);
  return isReadOnlyPosixExecutable(executable, args);
}

function isReadOnlyPosixExecutable(executable: string, args: string[]): boolean {
  if (!POSIX_READ_ONLY.has(executable)) return false;
  if (executable === "command") return isReadOnlyCommandWrapper(args);
  if (executable === "env") return isReadOnlyEnvWrapper(args);
  if (executable === "find") return isReadOnlyFind(args);
  if (executable === "xargs") return isReadOnlyXargs(args);
  if (executable === "sed") {
    return isReadOnlySed(args);
  }
  return true;
}

function isReadOnlyPowerShellExecutable(executable: string, args: string[]): boolean {
  if (executable === "git") return isReadOnlyGit(args);
  if (executable === "write-output" || executable === "write-host") return true;
  if (executable === "select-string" || executable === "select-object" || executable === "measure-object") return true;
  if (executable === "resolve-path" || executable === "split-path" || executable === "test-path") return true;
  if (executable === "sort-object" || executable === "where-object") return true;
  if (executable === "get-location" || executable === "get-content" || executable === "get-childitem") return true;
  if (executable === "get-command" || executable === "get-date" || executable === "get-filehash") return true;
  if (executable === "get-history" || executable === "get-item" || executable === "get-itemproperty") return true;
  if (executable.startsWith("get-")) return true;
  if (executable.startsWith("format-")) return true;
  return false;
}

function isReadOnlyGit(args: string[]): boolean {
  const parsed = gitSubcommand(args);
  if (!parsed || !READ_ONLY_GIT_SUBCOMMANDS.has(parsed.name)) return false;
  if (parsed.name === "branch") return isReadOnlyGitBranch(parsed.args);
  if (parsed.name === "remote") return isReadOnlyGitRemote(parsed.args);
  if (parsed.name === "tag") return isReadOnlyGitTag(parsed.args);
  return !hasGitOutputFileOption(parsed.args);
}

function gitSubcommand(args: string[]): { name: string; args: string[] } | undefined {
  const optionsWithValue = new Set(["-C", "-c", "--exec-path", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return args[index + 1] ? { name: args[index + 1]!.toLowerCase(), args: args.slice(index + 2) } : undefined;
    const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (optionsWithValue.has(optionName)) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return { name: arg.toLowerCase(), args: args.slice(index + 1) };
  }
  return undefined;
}

function isReadOnlyGitBranch(args: string[]): boolean {
  if (args.length === 0) return true;
  const listingFlags = new Set(["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--list", "-l", "--show-current", "--no-color", "--color"]);
  const flagsWithValue = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format", "--sort", "--column"]);
  let listingRequested = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (listingFlags.has(name)) {
      listingRequested = true;
      continue;
    }
    if (flagsWithValue.has(name)) {
      listingRequested = true;
      if (!arg.includes("=")) index += 1;
      continue;
    }
    if (arg.startsWith("-")) return false;
    if (!listingRequested) return false;
  }
  return true;
}

function isReadOnlyGitRemote(args: string[]): boolean {
  if (args.length === 0) return true;
  if (args.every((arg) => arg === "-v" || arg === "--verbose")) return true;
  const subcommand = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
  return subcommand === "get-url" || subcommand === "show";
}

function isReadOnlyGitTag(args: string[]): boolean {
  if (args.length === 0) return true;
  const listing = args.some((arg) => arg === "-l" || arg === "--list" || arg.startsWith("--list="));
  if (!listing) return false;
  return !args.some((arg) => arg === "-d" || arg === "--delete" || arg === "-f" || arg === "--force");
}

function isReadOnlyCommandWrapper(args: string[]): boolean {
  if (args.length === 0) return false;
  if (args[0] === "-v" || args[0] === "-V") return args.length >= 2;
  const nested = args[0] === "--" ? args.slice(1) : args;
  const executable = normalizeExecutable(nested[0], "posix");
  return executable !== undefined && executable !== "command" && isReadOnlyExecutable(executable, nested.slice(1), "posix");
}

function isReadOnlyEnvWrapper(args: string[]): boolean {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*$/s.test(arg)) {
      index += 1;
      continue;
    }
    if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir" || arg === "-S" || arg === "--split-string") {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const nested = args.slice(index);
  const executable = normalizeExecutable(nested[0], "posix");
  return executable !== undefined && executable !== "env" && isReadOnlyExecutable(executable, nested.slice(1), "posix");
}

function isReadOnlyFind(args: string[]): boolean {
  const mutatingActions = new Set(["-delete", "-ok", "-okdir", "-fls", "-fprint", "-fprint0", "-fprintf"]);
  for (let index = 0; index < args.length; index += 1) {
    const action = args[index]!.toLowerCase();
    if (mutatingActions.has(action)) return false;
    if (action !== "-exec" && action !== "-execdir") continue;
    const relativeEnd = args.slice(index + 1).findIndex((arg) => arg === ";" || arg === "+");
    if (relativeEnd < 0) return false;
    const end = index + 1 + relativeEnd;
    const nested = args.slice(index + 1, end);
    const executable = normalizeExecutable(nested[0], "posix");
    if (!executable || !isReadOnlyExecutable(executable, nested.slice(1), "posix")) return false;
    index = end;
  }
  return true;
}

function isReadOnlyXargs(args: string[]): boolean {
  let index = 0;
  const flagsWithValue = new Set(["-E", "-I", "-L", "-n", "-P", "-R", "-S", "-s", "--arg-file", "--delimiter", "--eof", "--max-args", "--max-chars", "--max-lines", "--max-procs", "--replace"]);
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "--") {
      index += 1;
      break;
    }
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (flagsWithValue.has(name)) {
      index += arg.includes("=") ? 1 : 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const nested = args.slice(index);
  if (!nested.length) return true;
  const executable = normalizeExecutable(nested[0], "posix");
  return Boolean(executable && executable !== "xargs" && isReadOnlyExecutable(executable, nested.slice(1), "posix"));
}

function hasGitOutputFileOption(args: string[]): boolean {
  return args.some((arg) => arg === "--output" || arg.startsWith("--output="));
}

function stripPosixAssignments(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*$/s.test(tokens[index]!)) index += 1;
  return tokens.slice(index);
}

function isReadOnlySed(args: string[]): boolean {
  if (args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || arg.startsWith("--in-place="))) return false;
  const scripts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-e" || arg === "--expression") {
      if (args[index + 1]) scripts.push(args[++index]!);
      continue;
    }
    if (arg.startsWith("--expression=")) scripts.push(arg.slice("--expression=".length));
    else if (!arg.startsWith("-") && scripts.length === 0) scripts.push(arg);
  }
  return !scripts.some((script) => /(?:^|[;}\n])\s*w(?:\s|$)/.test(script) || /^s(.).*\1[gpimne]*w(?:\s|$)/s.test(script));
}

function isSafeAutoApprovedExecutable(
  executable: string,
  args: string[],
  family: ShellFamily,
  cwd: string,
): boolean {
  if (isNestedShellExecutable(executable, args, family)) return false;
  if (family === "powershell") return isSafeAutoApprovedPowerShell(executable, args, cwd);
  return isSafeAutoApprovedPosix(executable, args, cwd);
}

function isSafeAutoApprovedPosix(executable: string, args: string[], cwd: string): boolean {
  if (executable === "mkdir") return hasOnlyWorkspacePaths(args, cwd, SAFE_POSIX_WRITE_FLAGS.mkdir, 1);
  if (executable === "touch") return hasOnlyWorkspacePaths(args, cwd, SAFE_POSIX_WRITE_FLAGS.touch, 1);
  if (executable === "cp") return hasOnlyWorkspacePaths(args, cwd, SAFE_POSIX_WRITE_FLAGS.cp, 2);
  if (executable === "mv") return hasOnlyWorkspacePaths(args, cwd, SAFE_POSIX_WRITE_FLAGS.mv, 2);
  return false;
}

function isSafeAutoApprovedPowerShell(executable: string, args: string[], cwd: string): boolean {
  if (executable === "new-item") {
    return hasOnlyWorkspacePaths(args, cwd, SAFE_POWERSHELL_WRITE_FLAGS["new-item"], 1);
  }
  if (executable === "copy-item") {
    return hasOnlyWorkspacePaths(args, cwd, SAFE_POWERSHELL_WRITE_FLAGS["copy-item"], 2);
  }
  if (executable === "move-item") {
    return hasOnlyWorkspacePaths(args, cwd, SAFE_POWERSHELL_WRITE_FLAGS["move-item"], 2);
  }
  if (executable === "rename-item") {
    return hasOnlyWorkspacePaths(args, cwd, SAFE_POWERSHELL_WRITE_FLAGS["rename-item"], 2);
  }
  return false;
}

function hasOnlyWorkspacePaths(
  args: string[],
  cwd: string,
  allowedFlags: Set<string>,
  minimumPaths: number,
): boolean {
  const paths: string[] = [];
  let expectValueForNamedArgument = false;

  for (const arg of args) {
    if (!arg) continue;
    if (expectValueForNamedArgument) {
      if (!isWorkspacePath(cwd, arg)) return false;
      paths.push(arg);
      expectValueForNamedArgument = false;
      continue;
    }
    if (arg === "--") continue;
    if (arg.startsWith("-")) {
      const lowered = arg.toLowerCase();
      if (allowedFlags.has(arg) || allowedFlags.has(lowered)) continue;
      if (
        lowered === "-path"
        || lowered === "-literalpath"
        || lowered === "-destination"
        || lowered === "-newname"
      ) {
        expectValueForNamedArgument = true;
        continue;
      }
      return false;
    }
    if (!isWorkspacePath(cwd, arg)) return false;
    paths.push(arg);
  }

  return !expectValueForNamedArgument && paths.length >= minimumPaths;
}

function isWorkspacePath(cwd: string, value: string): boolean {
  if (!value || value.startsWith("-") || /[*?[\]{}~]/.test(value)) return false;
  const target = resolve(cwd, value);
  const rel = relative(resolve(cwd), target);
  return rel === "" || (!rel.startsWith("..") && rel !== "..");
}

function isAsciiWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function isNonAsciiWhitespace(char: string): boolean {
  return /\s/u.test(char) && !isAsciiWhitespace(char);
}

function isPowerShellSplatStart(command: string, index: number): boolean {
  const char = command[index];
  const next = command[index + 1];
  const prev = index > 0 ? command[index - 1] : undefined;
  if (char !== "@" || next === undefined) return false;
  if (prev !== undefined && /[A-Za-z0-9_.-]/.test(prev)) return false;
  return /[A-Za-z_{(]/.test(next);
}

function isNestedShellExecutable(executable: string, args: string[], family: ShellFamily): boolean {
  if (family === "powershell") {
    if (!POWERSHELL_EXECUTABLES.has(executable)) return false;
    return args.some((arg) => {
      const lowered = arg.toLowerCase();
      return lowered === "-command" || lowered === "-c" || lowered === "-encodedcommand" || lowered === "-ec";
    });
  }

  if (!POSIX_SHELL_EXECUTABLES.has(executable)) return false;
  return args.some((arg) => arg === "-c");
}
