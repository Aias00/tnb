import { scanSecurity } from "./scanner";
import { renderSecurityReport, type SecurityReportFormat } from "./report";

type Writer = { write(text: string): unknown };

type ParsedSecurityArgs = {
  all: boolean;
  staged: boolean;
  json: boolean;
  format?: SecurityReportFormat;
  hook: boolean;
  help: boolean;
  baseCommit?: string;
  pathGlob?: string;
  excludePaths: string[];
  paths: string[];
};

export async function runSecurityScanCommand(options: {
  argv: string[];
  cwd: string;
  stdin?: NodeJS.ReadStream;
  stdout: Writer;
  stderr: Writer;
}): Promise<number> {
  try {
    const parsed = parseArgs(options.argv);
    if (parsed.help) {
      options.stdout.write(`Usage: tnb security-scan [paths...] [options]

Run local deterministic SAST checks without uploading source code.

Options:
  --all                 Scan the full workspace
  --staged              Scan staged Git changes
  --base <commit>       Scan files changed since the given commit or ref
  --path-glob <glob>    Restrict matches to files matching a workspace-relative glob
  --exclude <path>      Exclude a workspace-relative path prefix (repeatable)
  --json                Emit machine-readable JSON
  --format <format>     Report format: text, json, markdown, or sarif
  --hook                Read hook payload JSON from stdin
  -h, --help            Show help
`);
      return 0;
    }

    if (parsed.hook && options.stdin) {
      let input = "";
      for await (const chunk of options.stdin) input += chunk.toString();
      const payload = JSON.parse(input) as Record<string, unknown>;
      const toolInput = typeof payload.tool_input === "object" && payload.tool_input !== null ? payload.tool_input as Record<string, unknown> : {};
      const path = typeof toolInput.path === "string"
        ? toolInput.path
        : typeof toolInput.file_path === "string"
          ? toolInput.file_path
          : undefined;
      if (!path) return 0;
      parsed.paths.splice(0, parsed.paths.length, path);
    }

    const result = await scanSecurity({
      cwd: options.cwd,
      ...(parsed.paths.length ? { paths: parsed.paths } : {}),
      ...(parsed.all ? { all: true } : {}),
      ...(parsed.staged ? { staged: true } : {}),
      ...(parsed.baseCommit ? { baseCommit: parsed.baseCommit } : {}),
      ...(parsed.pathGlob ? { pathGlob: parsed.pathGlob } : {}),
      ...(parsed.excludePaths.length ? { excludePaths: parsed.excludePaths } : {}),
    });

    if (parsed.hook) {
      if (result.findings.length) {
        options.stdout.write(`${JSON.stringify({ hookSpecificOutput: { additionalContext: formatFindings(result.findings) } })}\n`);
      }
      return 0;
    }

    if (parsed.json || parsed.format) {
      options.stdout.write(`${renderSecurityReport(result, parsed.json ? "json" : parsed.format!)}\n`);
    } else {
      options.stdout.write(`Scanned ${result.scannedFiles} file(s); found ${result.findings.length} issue(s).\n`);
      options.stdout.write(`Scope: ${renderScope(result)}\n`);
      if (result.findings.length) options.stdout.write(`${formatFindings(result.findings)}\n`);
    }
    return result.findings.some((finding) => finding.severity === "high") ? 2 : 0;
  } catch (error) {
    options.stderr.write(`tnb: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseArgs(argv: string[]): ParsedSecurityArgs {
  const parsed: ParsedSecurityArgs = {
    all: false,
    staged: false,
    json: false,
    hook: false,
    help: false,
    excludePaths: [],
    paths: [],
  };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--all") parsed.all = true;
    else if (value === "--staged") parsed.staged = true;
    else if (value === "--json") parsed.json = true;
    else if (value === "--format") parsed.format = reportFormat(requireOptionValue(argv, ++index, "--format"));
    else if (value.startsWith("--format=")) parsed.format = reportFormat(value.slice("--format=".length));
    else if (value === "--hook") parsed.hook = true;
    else if (value === "--help" || value === "-h" || value === "help") parsed.help = true;
    else if (value === "--base") parsed.baseCommit = requireOptionValue(argv, ++index, "--base");
    else if (value.startsWith("--base=")) parsed.baseCommit = value.slice("--base=".length);
    else if (value === "--path-glob") parsed.pathGlob = requireOptionValue(argv, ++index, "--path-glob");
    else if (value.startsWith("--path-glob=")) parsed.pathGlob = value.slice("--path-glob=".length);
    else if (value === "--exclude") parsed.excludePaths.push(requireOptionValue(argv, ++index, "--exclude"));
    else if (value.startsWith("--exclude=")) parsed.excludePaths.push(value.slice("--exclude=".length));
    else if (value.startsWith("--")) throw new Error(`unknown security-scan option: ${value}`);
    else parsed.paths.push(value);
  }
  return parsed;
}

function reportFormat(value: string): SecurityReportFormat {
  if (value !== "text" && value !== "json" && value !== "markdown" && value !== "sarif") {
    throw new Error("--format must be one of: text, json, markdown, sarif");
  }
  return value;
}

function requireOptionValue(argv: string[], index: number, name: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function renderScope(result: Awaited<ReturnType<typeof scanSecurity>>): string {
  const base = result.scope.mode === "diff" ? `diff from ${result.scope.baseCommit}` : result.scope.mode;
  const filters = [
    ...(result.scope.pathGlob ? [`glob=${result.scope.pathGlob}`] : []),
    ...(result.scope.excludePaths.length ? [`exclude=${result.scope.excludePaths.join(",")}`] : []),
  ];
  return filters.length ? `${base} (${filters.join(" ")})` : base;
}

function formatFindings(findings: Awaited<ReturnType<typeof scanSecurity>>["findings"]): string {
  return findings
    .map((finding) => {
      const source = finding.source === "builtin" ? "" : ` [${finding.source}]`;
      return `${finding.severity.toUpperCase()} ${finding.path}:${finding.line} ${finding.rule}${source} (${finding.cwe}) — ${finding.message}`;
    })
    .join("\n");
}
