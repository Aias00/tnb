import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { gitRoot, runGit } from "../git/command";
import { scanTypeScriptDataFlow } from "./typescript-analysis";
import { scanPortableDataFlow, type PortableSourceFile } from "./portable-analysis";

export type SecuritySeverity = "high" | "medium" | "low";
export type SecurityRuleSource = "builtin" | "user" | "project";
export type SecurityScanMode = "paths" | "all" | "working-tree" | "staged" | "diff";

export type SecurityFinding = {
  rule: string;
  severity: SecuritySeverity;
  cwe: string;
  path: string;
  line: number;
  message: string;
  evidence: string;
  source: SecurityRuleSource;
  category: string;
  confidence: "high" | "medium" | "low";
  remediation: string;
  language?: string;
};

export type SecurityScanResult = {
  scannedFiles: number;
  findings: SecurityFinding[];
  scope: {
    mode: SecurityScanMode;
    requestedPaths: string[];
    excludePaths: string[];
    pathGlob?: string;
    baseCommit?: string;
  };
  rules: {
    builtin: number;
    customUser: number;
    customProject: number;
    total: number;
  };
  summary: {
    severity: Record<SecuritySeverity, number>;
    categories: Record<string, number>;
    languages: Record<string, number>;
  };
};

type SecurityScanOptions = {
  cwd: string;
  paths?: string[];
  all?: boolean;
  staged?: boolean;
  baseCommit?: string;
  pathGlob?: string;
  excludePaths?: string[];
  signal?: AbortSignal;
};

type SecurityRule = {
  name: string;
  source: SecurityRuleSource;
  severity: SecuritySeverity;
  cwe: string;
  message: string;
  category: string;
  confidence: SecurityFinding["confidence"];
  remediation: string;
  redact?: boolean;
  pattern?: RegExp;
  substrings?: string[];
  pathGlob?: Bun.Glob;
  includePaths?: string[];
  excludePaths?: string[];
};

type RawCustomRule = {
  ruleName?: string;
  substrings?: string[];
  regex?: string;
  path_glob?: string;
  paths?: string[];
  exclude_paths?: string[];
  severity?: string;
  reminder?: string;
};

type ScanScope = {
  mode: SecurityScanMode;
  requestedPaths: string[];
  baseCommit?: string;
};

const BUILTIN_RULES: SecurityRule[] = [
  rule("private-key", "high", "CWE-798", "secrets", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "Private key material must not be committed.", "Remove and rotate the key; load credentials from a secret store.", true),
  rule("aws-access-key", "high", "CWE-798", "secrets", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, "A likely AWS access key is hardcoded.", "Remove and rotate the credential; use workload identity or a secret store.", true),
  rule("generic-secret", "high", "CWE-798", "secrets", /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*["'][^"'\s]{12,}["']/i, "A likely credential is hardcoded.", "Move the value to a protected runtime secret and rotate it.", true),
  rule("disabled-tls-verification", "high", "CWE-295", "transport", /(?:rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true)/, "TLS certificate verification is disabled.", "Enable certificate and hostname verification; configure an explicit trust root if needed."),
  rule("dynamic-code-execution", "medium", "CWE-95", "injection", /\b(?:eval|exec)\s*\(/, "Dynamic code execution requires strict control of all input.", "Replace dynamic evaluation with a parser or strict allowlist."),
  rule("shell-command-construction", "medium", "CWE-78", "injection", /\b(?:exec|system|popen)\s*\(\s*(?:f["']|`|[^)]*\+)/, "A shell command appears to be constructed dynamically; use argv execution and validate input.", "Use argv-based process execution and validate each argument."),
  rule("interpolated-sql", "high", "CWE-89", "injection", /\b(?:execute|query)\s*\(\s*(?:f["']|`|[^)]*\+)/i, "A SQL statement appears to be interpolated; use parameterized queries.", "Use prepared statements with bound parameters."),
  rule("weak-password-hash", "low", "CWE-328", "cryptography", /\b(?:md5|sha1)\s*\([^)]*(?:password|passwd|secret)/i, "A weak digest appears to protect credential material.", "Use Argon2id, scrypt, or bcrypt with an appropriate work factor."),
  rule("unsafe-deserialization", "high", "CWE-502", "deserialization", /\b(?:pickle\.loads?|yaml\.load\s*\(|ObjectInputStream\s*\(|BinaryFormatter\s*\()/, "Potentially unsafe deserialization can instantiate attacker-controlled objects.", "Use a safe data-only format or a safe loader with a strict schema."),
  rule("cors-credentials-wildcard", "high", "CWE-942", "configuration", /(?:Access-Control-Allow-Origin[^\n]*\*.*Access-Control-Allow-Credentials[^\n]*true|origin\s*:\s*["']\*["'][^\n]*credentials\s*:\s*true)/i, "Credentialed cross-origin access is configured with a wildcard origin.", "Allowlist trusted origins and vary responses by Origin."),
  rule("dangerous-html", "medium", "CWE-79", "xss", /(?:dangerouslySetInnerHTML|\.innerHTML\s*=|v-html\s*=)/, "Raw HTML is written to a rendering sink.", "Sanitize untrusted HTML with a maintained allowlist sanitizer or render it as text."),
  rule("path-join-untrusted", "medium", "CWE-22", "path-traversal", /(?:sendFile|readFile|writeFile|open)\s*\([^\n]*(?:req\.|request\.|params|query|argv)/i, "A filesystem sink appears to consume request or argument data directly.", "Resolve against an approved root, canonicalize, and reject paths outside it."),
  rule("jwt-no-verification", "high", "CWE-347", "authentication", /(?:jwt\.decode\s*\([^\n]*(?:verify\s*=\s*False|options\s*=\s*\{[^}]*verify_signature[^}]*False)|algorithms?\s*[:=]\s*\[["']none["']\])/i, "JWT signature verification appears disabled.", "Require signature verification and allowlist the expected algorithm and issuer."),
  rule("java-runtime-exec", "high", "CWE-78", "injection", /\bRuntime\.getRuntime\(\)\.exec\s*\([^)]*(?:\+|String\.format|request\.|getParameter)/, "Java command execution appears to include dynamically constructed input.", "Use ProcessBuilder with a fixed executable and separately validated arguments."),
  rule("python-shell-true", "high", "CWE-78", "injection", /\bsubprocess\.(?:run|call|Popen|check_output)\s*\([^\n]*shell\s*=\s*True/i, "Python subprocess execution enables shell parsing.", "Pass an argv list with shell=False and validate each argument."),
  rule("go-shell-command", "high", "CWE-78", "injection", /\bexec\.Command\s*\(\s*["'](?:sh|bash|cmd|powershell)["']\s*,\s*["'](?:-c|\/C|Command)["']\s*,/, "Go launches a command through a shell interpreter.", "Invoke a fixed executable directly with separated, validated argv values."),
  rule("php-unsafe-unserialize", "high", "CWE-502", "deserialization", /\bunserialize\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE)/i, "PHP deserializes request-controlled data.", "Use a data-only format with schema validation; never unserialize untrusted input."),
  rule("ruby-shell-interpolation", "high", "CWE-78", "injection", /(?:\bsystem\s*\(|`)[^\n]*(?:#\{|params\[)/, "Ruby shell execution appears to interpolate request-controlled data.", "Use argv-form process execution and validate arguments against an allowlist."),
  rule("dotnet-process-shell", "high", "CWE-78", "injection", /\bProcess\.Start\s*\([^\n]*(?:Request\.|\+|\$\")/, ".NET process execution appears to use dynamically constructed input.", "Use ProcessStartInfo.ArgumentList with a fixed executable and validated arguments."),
  rule("c-unsafe-copy", "medium", "CWE-120", "memory-safety", /\b(?:strcpy|strcat|gets|sprintf)\s*\(/, "A bounds-unsafe C/C++ string operation is used.", "Use a size-aware API and verify destination capacity and termination."),
  rule("solidity-tx-origin", "high", "CWE-346", "authentication", /\btx\.origin\b/, "Solidity authorization relies on tx.origin.", "Authorize against msg.sender and use explicit access-control roles."),
  rule("kotlin-webview-javascript", "medium", "CWE-749", "mobile", /javaScriptEnabled\s*=\s*true/, "Android WebView JavaScript is enabled and requires a constrained content origin.", "Disable JavaScript unless required; restrict navigation and bridge exposure to trusted origins."),
];

const EXTERNAL_INPUT = /(?:\b(?:req\.(?:query|params|body|headers|cookies)|request\.(?:args|form|json)|process\.argv|Deno\.args|r\.(?:URL\.Query|FormValue)|request\.getParameter|Request\.(?:Query|Form|RouteValues)|params\s*\[)|\$_(?:GET|POST|REQUEST|COOKIE)\b)/i;

const FLOW_RULES = [
  { name: "request-to-shell", severity: "high" as const, cwe: "CWE-78", category: "injection", source: EXTERNAL_INPUT, sink: /(?:\b(?:exec|execSync|system|popen|spawn|spawnSync)\s*\(|Runtime\.getRuntime\(\)\.exec\s*\(|subprocess\.(?:run|call|Popen|check_output)\s*\(|exec\.Command\s*\(|Process\.Start\s*\()/, message: "Request-controlled data reaches a command-execution sink through local assignments.", remediation: "Trace the value; use fixed executables, argv arguments, and an allowlist." },
  { name: "request-to-sql", severity: "high" as const, cwe: "CWE-89", category: "injection", source: EXTERNAL_INPUT, sink: /\b(?:query|execute|raw|execSql|prepareStatement)\s*\(/i, message: "Request-controlled data reaches a database execution sink through local assignments.", remediation: "Trace the value and bind it through parameterized queries." },
  { name: "request-to-file", severity: "medium" as const, cwe: "CWE-22", category: "path-traversal", source: EXTERNAL_INPUT, sink: /\b(?:readFile|readFileSync|writeFile|writeFileSync|open|sendFile|createReadStream|createWriteStream|ReadFile|WriteFile|Open|OpenFile|readAllBytes|write|GetFile|OpenRead|OpenWrite)\s*\(/, message: "Externally controlled data reaches a filesystem sink through local assignments.", remediation: "Canonicalize the path beneath an approved root before filesystem access." },
];

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "vendor", "dist", "build", "coverage", ".next"]);
const CUSTOM_RULE_LIMIT = 50;
const CUSTOM_REGEX_LIMIT = 1_000;
const CUSTOM_REMINDER_LIMIT = 1_024;

export async function scanSecurity(options: SecurityScanOptions): Promise<SecurityScanResult> {
  const modeCount = Number(options.all === true) + Number(options.staged === true) + Number(Boolean(options.baseCommit));
  if (modeCount > 1) {
    throw new Error("security scan modes --all, --staged, and --base are mutually exclusive");
  }

  const root = await realpath(resolve(options.cwd));
  const repoRoot = await resolveRepoRoot(root);
  const scope = await resolveScanScope(root, options);
  const customRules = await loadCustomRules(repoRoot);
  const pathGlob = options.pathGlob ? new Bun.Glob(options.pathGlob) : undefined;
  const excludedPaths = normalizePathList(options.excludePaths ?? []);
  const files = new Set<string>();

  for (const value of scope.requestedPaths) {
    options.signal?.throwIfAborted();
    const target = resolve(root, value);
    assertInside(root, target);
    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(target);
    } catch {
      continue;
    }
    assertInside(root, canonicalTarget);
    await collectFiles(canonicalTarget, files, options.signal);
  }

  const findings: SecurityFinding[] = [];
  const typeScriptFiles: string[] = [];
  const portableFiles: PortableSourceFile[] = [];
  let scannedFiles = 0;
  const rules = [...BUILTIN_RULES, ...customRules];
  for (const file of [...files].sort()) {
    options.signal?.throwIfAborted();
    const relativePath = normalizePath(relative(root, file));
    if (!shouldScanPath(relativePath, pathGlob, excludedPaths)) continue;
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;
    scannedFiles += 1;
    if (/\.(?:[cm]?[jt]sx?)$/i.test(file)) typeScriptFiles.push(file);
    const lines = content.split(/\r?\n/);
    portableFiles.push({ path: relativePath, language: detectSecurityLanguage(relativePath), lines });
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      for (const rule of rules) {
        if (!ruleMatches(rule, relativePath, line)) continue;
        findings.push({
          rule: rule.name,
          severity: rule.severity,
          cwe: rule.cwe,
          path: relativePath,
          line: index + 1,
          message: rule.message,
          evidence: rule.redact ? "[redacted potential secret]" : line.trim(),
          source: rule.source,
          category: rule.category,
          confidence: rule.confidence,
          remediation: rule.remediation,
        });
      }
    }
    findings.push(...scanLocalFlows(relativePath, lines));
    findings.push(...scanProjectConfiguration(relativePath, content, lines));
  }
  findings.push(...await scanTypeScriptDataFlow(root, typeScriptFiles));
  findings.push(...scanPortableDataFlow(portableFiles).map((finding) => ({ ...finding, source: "builtin" as const })));
  const normalizedFindings = deduplicateFindings(findings).map((finding) => ({
    ...finding,
    language: finding.language ?? detectSecurityLanguage(finding.path),
  }));

  return {
    scannedFiles,
    findings: normalizedFindings,
    scope: {
      mode: scope.mode,
      requestedPaths: scope.requestedPaths,
      excludePaths: excludedPaths,
      ...(options.pathGlob ? { pathGlob: options.pathGlob } : {}),
      ...(scope.baseCommit ? { baseCommit: scope.baseCommit } : {}),
    },
    rules: {
      builtin: BUILTIN_RULES.length + FLOW_RULES.length,
      customUser: customRules.filter((rule) => rule.source === "user").length,
      customProject: customRules.filter((rule) => rule.source === "project").length,
      total: rules.length + FLOW_RULES.length,
    },
    summary: summarizeFindings(normalizedFindings),
  };
}

function summarizeFindings(findings: SecurityFinding[]): SecurityScanResult["summary"] {
  const severity = { high: 0, medium: 0, low: 0 };
  const categories: Record<string, number> = {};
  const languages: Record<string, number> = {};
  for (const finding of findings) {
    severity[finding.severity] += 1;
    categories[finding.category] = (categories[finding.category] ?? 0) + 1;
    const language = finding.language ?? "text";
    languages[language] = (languages[language] ?? 0) + 1;
  }
  return { severity, categories, languages };
}

function detectSecurityLanguage(path: string): string {
  const extension = path.toLowerCase().match(/\.([^.\/]+)$/)?.[1];
  return ({
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
    c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", rb: "ruby",
    scala: "scala", dart: "dart", lua: "lua", sol: "solidity", sh: "shell", yml: "yaml", yaml: "yaml",
  } as Record<string, string>)[extension ?? ""] ?? extension ?? "text";
}

function scanProjectConfiguration(path: string, content: string, lines: string[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)) {
    const usesPrivilegedEvent = /(^|\n)\s*(?:on\s*:\s*)?pull_request_target\s*(?::|$)/m.test(content);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (/\brun\s*:.*\$\{\{\s*github\.event\./.test(line)) {
        findings.push(configurationFinding(
          "github-actions-script-injection", "high", "CWE-78", path, index + 1,
          "GitHub event data is interpolated directly into a workflow shell command.", line,
          "Pass event values through a quoted environment variable and validate them before use.",
        ));
      }
      if (usesPrivilegedEvent && /\bref\s*:.*github\.event\.pull_request\.head/.test(line)) {
        findings.push(configurationFinding(
          "pull-request-target-untrusted-checkout", "high", "CWE-829", path, index + 1,
          "A pull_request_target workflow checks out pull-request-controlled code with privileged repository credentials.", line,
          "Use pull_request for untrusted code or avoid executing the checked-out head in the privileged workflow.",
        ));
      }
    }
  }
  if (path === "package.json" || path.endsWith("/package.json")) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(content);
    } catch {
      return findings;
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return findings;
    const record = manifest as Record<string, unknown>;
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      const dependencies = record[section];
      if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
      for (const [name, rawVersion] of Object.entries(dependencies as Record<string, unknown>)) {
        if (typeof rawVersion !== "string") continue;
        const line = lines.findIndex((value) => value.includes(`"${name}"`)) + 1 || 1;
        if (rawVersion === "*" || rawVersion.toLowerCase() === "latest") {
          findings.push(configurationFinding(
            "unbounded-dependency-version", "low", "CWE-1104", path, line,
            `Dependency ${name} uses an unbounded version selector.`, lines[line - 1] ?? name,
            "Use a reviewed version range and commit the package-manager lockfile.",
          ));
        } else if (/^(?:https?:|git\+|github:|gitlab:|bitbucket:)/i.test(rawVersion)) {
          findings.push(configurationFinding(
            "remote-dependency-source", "medium", "CWE-829", path, line,
            `Dependency ${name} installs directly from a remote source.`, lines[line - 1] ?? name,
            "Use a registry release with integrity metadata or pin an immutable reviewed commit.",
          ));
        }
      }
    }
    const scripts = record.scripts;
    if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
      for (const phase of ["preinstall", "install", "postinstall"]) {
        const command = (scripts as Record<string, unknown>)[phase];
        if (typeof command !== "string" || !/(?:curl|wget).*(?:\||\bsh\b|\bbash\b)/i.test(command)) continue;
        const line = lines.findIndex((value) => value.includes(`"${phase}"`)) + 1 || 1;
        findings.push(configurationFinding(
          "remote-install-script", "high", "CWE-494", path, line,
          `${phase} downloads and executes remote content.`, lines[line - 1] ?? command,
          "Vendor and verify the artifact before executing it; avoid download-to-shell install hooks.",
        ));
      }
    }
  }
  return findings;
}

function configurationFinding(
  rule: string,
  severity: SecuritySeverity,
  cwe: string,
  path: string,
  line: number,
  message: string,
  evidence: string,
  remediation: string,
): SecurityFinding {
  return {
    rule,
    severity,
    cwe,
    path,
    line,
    message,
    evidence: evidence.trim().slice(0, 500),
    source: "builtin",
    category: "supply-chain",
    confidence: "high",
    remediation,
  };
}

function rule(
  name: string,
  severity: SecuritySeverity,
  cwe: string,
  category: string,
  pattern: RegExp,
  message: string,
  remediation: string,
  redact = false,
): SecurityRule {
  return { name, source: "builtin", severity, cwe, category, pattern, message, remediation, confidence: "high", ...(redact ? { redact: true } : {}) };
}

function scanLocalFlows(path: string, lines: string[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (let sourceLine = 0; sourceLine < lines.length; sourceLine += 1) {
    for (const rule of FLOW_RULES) {
      rule.source.lastIndex = 0;
      if (!rule.source.test(lines[sourceLine]!)) continue;
      const tainted = new Set(extractAssignedNames(lines[sourceLine]!));
      const end = Math.min(lines.length, sourceLine + 40);
      for (let sinkLine = sourceLine; sinkLine < end; sinkLine += 1) {
        const line = lines[sinkLine]!;
        if (sinkLine > sourceLine) {
          const assigned = extractAssignedNames(line);
          rule.source.lastIndex = 0;
          if (assigned.length && (rule.source.test(line) || containsIdentifier(line, tainted))) {
            for (const name of assigned) tainted.add(name);
          }
        }
        rule.sink.lastIndex = 0;
        if (!rule.sink.test(line)) continue;
        if (rule.name === "request-to-sql" && /\b(?:req|request|r)\.query\s*\(/i.test(line)) continue;
        rule.source.lastIndex = 0;
        if (!rule.source.test(line) && !containsIdentifier(line, tainted)) continue;
        findings.push({
          rule: rule.name,
          severity: rule.severity,
          cwe: rule.cwe,
          path,
          line: sinkLine + 1,
          message: rule.message,
          evidence: line.trim(),
          source: "builtin",
          category: rule.category,
          confidence: "medium",
          remediation: rule.remediation,
        });
        break;
      }
    }
  }
  return deduplicateFindings(findings);
}

function extractAssignedNames(line: string): string[] {
  const beforeAssignment = /^(.*?)\s*(?::=|=(?!=|>))/.exec(line)?.[1]?.trim();
  if (!beforeAssignment) return [];
  const identifiers = beforeAssignment.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const excluded = new Set(["const", "let", "var", "final", "public", "private", "protected", "internal", "static", "String", "string", "char", "int", "long", "bool", "boolean", "auto"]);
  const name = identifiers.reverse().find((identifier) => !excluded.has(identifier));
  return name ? [name] : [];
}

function containsIdentifier(line: string, identifiers: Set<string>): boolean {
  for (const identifier of identifiers) {
    if (new RegExp(`\\b${escapeRegex(identifier)}\\b`).test(line)) return true;
  }
  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deduplicateFindings(findings: SecurityFinding[]): SecurityFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.rule}:${finding.path}:${finding.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveScanScope(root: string, options: SecurityScanOptions): Promise<ScanScope> {
  if (options.paths?.length) {
    return { mode: "paths", requestedPaths: options.paths };
  }
  if (options.all) {
    return { mode: "all", requestedPaths: ["."] };
  }
  if (options.baseCommit) {
    const baseCommit = await resolveCommit(root, options.baseCommit);
    return {
      mode: "diff",
      requestedPaths: await changedPathsSinceCommit(root, baseCommit),
      baseCommit,
    };
  }
  if (options.staged) {
    return { mode: "staged", requestedPaths: await changedPaths(root, { staged: true }) };
  }
  return { mode: "working-tree", requestedPaths: await changedPaths(root, { staged: false }) };
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    return await gitRoot(cwd);
  } catch {
    return cwd;
  }
}

async function resolveCommit(cwd: string, ref: string): Promise<string> {
  const result = await runGit(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return result.stdout.trim();
}

async function changedPathsSinceCommit(cwd: string, baseCommit: string): Promise<string[]> {
  const committed = await readGitLines(
    cwd,
    ["diff", "--name-only", "--diff-filter=ACMR", `${baseCommit}...HEAD`],
    false,
  );
  const local = await changedPaths(cwd, { staged: false });
  const merged = new Set([...committed, ...local]);
  return merged.size ? [...merged] : [];
}

async function changedPaths(cwd: string, options: { staged: boolean }): Promise<string[]> {
  const staged = await readGitLines(
    cwd,
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    false,
  );
  if (options.staged) return staged;
  const unstaged = await readGitLines(
    cwd,
    ["diff", "--name-only", "--diff-filter=ACMR"],
    false,
  );
  const untracked = await readGitLines(
    cwd,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    true,
  );
  const merged = new Set([...staged, ...unstaged, ...untracked]);
  return merged.size ? [...merged] : [];
}

async function readGitLines(cwd: string, args: string[], nulDelimited: boolean): Promise<string[]> {
  const result = await runGit(cwd, args, { allowFailure: true });
  if (result.exitCode !== 0) return ["."];
  return (nulDelimited ? result.stdout.split("\0") : result.stdout.split(/\r?\n/))
    .map((value) => value.trim())
    .filter(Boolean);
}

async function collectFiles(path: string, files: Set<string>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let info;
  try {
    info = await stat(path);
  } catch {
    return;
  }
  if (info.isFile()) {
    files.add(path);
    return;
  }
  if (!info.isDirectory()) return;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name))) continue;
    await collectFiles(resolve(path, entry.name), files, signal);
  }
}

function shouldScanPath(path: string, pathGlob: Bun.Glob | undefined, excludePaths: string[]): boolean {
  if (pathGlob && !pathGlob.match(path)) return false;
  return !excludePaths.some((prefix) => matchesPathPrefix(path, prefix));
}

function ruleMatches(rule: SecurityRule, path: string, line: string): boolean {
  if (rule.pathGlob && !rule.pathGlob.match(path)) return false;
  if (rule.includePaths?.length && !rule.includePaths.some((prefix) => matchesPathPrefix(path, prefix))) return false;
  if (rule.excludePaths?.some((prefix) => matchesPathPrefix(path, prefix))) return false;
  if (rule.substrings?.some((value) => line.includes(value))) return true;
  if (!rule.pattern) return false;
  rule.pattern.lastIndex = 0;
  return rule.pattern.test(line);
}

async function loadCustomRules(repoRoot: string): Promise<SecurityRule[]> {
  const merged = new Map<string, SecurityRule>();
  for (const file of [
    { path: join(homedir(), ".qodersec", "security-patterns.yaml"), source: "user" as const },
    { path: join(homedir(), ".tnb", "security-patterns.yaml"), source: "user" as const },
    { path: join(repoRoot, ".codesec", "security-patterns.yaml"), source: "project" as const },
    { path: join(repoRoot, ".tnb", "security-patterns.yaml"), source: "project" as const },
  ]) {
    for (const rule of await loadRulesFromFile(file.path, file.source)) {
      merged.set(rule.name, rule);
    }
  }
  return [...merged.values()].slice(0, CUSTOM_RULE_LIMIT);
}

async function loadRulesFromFile(path: string, source: SecurityRuleSource): Promise<SecurityRule[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return parseRuleYaml(content)
    .map((rule) => compileCustomRule(rule, source))
    .filter((rule): rule is SecurityRule => rule !== undefined);
}

function compileCustomRule(rule: RawCustomRule, source: SecurityRuleSource): SecurityRule | undefined {
  const name = normalizeScalar(rule.ruleName);
  const message = normalizeScalar(rule.reminder);
  if (!name || !message || message.length > CUSTOM_REMINDER_LIMIT) return undefined;

  const substrings = normalizeStringArray(rule.substrings);
  const regexSource = normalizeScalar(rule.regex);
  if (!substrings.length && !regexSource) return undefined;

  const pattern = compileRegex(regexSource);
  if (regexSource && !pattern) return undefined;

  return {
    name,
    source,
    severity: normalizeSeverity(rule.severity),
    cwe: "CUSTOM",
    message,
    category: "custom",
    confidence: "medium",
    remediation: message,
    ...(substrings.length ? { substrings } : {}),
    ...(pattern ? { pattern } : {}),
    ...(rule.path_glob ? { pathGlob: new Bun.Glob(rule.path_glob) } : {}),
    ...(rule.paths?.length ? { includePaths: normalizePathList(rule.paths) } : {}),
    ...(rule.exclude_paths?.length ? { excludePaths: normalizePathList(rule.exclude_paths) } : {}),
  };
}

function compileRegex(pattern: string | undefined): RegExp | undefined {
  if (!pattern || pattern.length > CUSTOM_REGEX_LIMIT || hasDangerousRegex(pattern)) return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function hasDangerousRegex(pattern: string): boolean {
  return /(\([^)]*[+*][^)]*\)[+*?])/.test(pattern) || /\(([^)|]+)\|\1(?:\|[^)]*)*\)[+*?]/.test(pattern);
}

function parseRuleYaml(text: string): RawCustomRule[] {
  const rules: RawCustomRule[] = [];
  let current: RawCustomRule | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const entryStart = /^-\s*(.*)$/.exec(line);
    if (entryStart) {
      current = {};
      rules.push(current);
      if (entryStart[1]) assignRuleField(current, entryStart[1]);
      continue;
    }
    if (current) assignRuleField(current, line);
  }
  return rules;
}

function assignRuleField(rule: RawCustomRule, line: string): void {
  const separator = line.indexOf(":");
  if (separator <= 0) return;
  const key = line.slice(0, separator).trim() as keyof RawCustomRule;
  const rawValue = line.slice(separator + 1).trim();
  switch (key) {
    case "ruleName":
      rule.ruleName = parseScalar(rawValue);
      break;
    case "regex":
      rule.regex = parseScalar(rawValue);
      break;
    case "severity":
      rule.severity = parseScalar(rawValue);
      break;
    case "reminder":
      rule.reminder = parseScalar(rawValue);
      break;
    case "path_glob":
      rule.path_glob = parseScalar(rawValue);
      break;
    case "substrings":
      rule.substrings = parseStringArray(rawValue);
      break;
    case "paths":
      rule.paths = parseStringArray(rawValue);
      break;
    case "exclude_paths":
      rule.exclude_paths = parseStringArray(rawValue);
      break;
    default:
      break;
  }
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return unquote(trimmed);
  }
  return trimmed;
}

function parseStringArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const values: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const character = trimmed[index]!;
    const previous = index > 0 ? trimmed[index - 1] : "";
    if ((character === "\"" || character === "'") && previous !== "\\") {
      if (!quote) {
        quote = character;
        continue;
      }
      if (quote === character) {
        quote = undefined;
        continue;
      }
    }
    if (character === "," && !quote) {
      const value = normalizeScalar(current);
      if (value) values.push(value);
      current = "";
      continue;
    }
    current += character;
  }
  const last = normalizeScalar(current);
  if (last) values.push(last);
  return values;
}

function unquote(value: string): string {
  if (value.startsWith("\"")) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}

function normalizeScalar(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeStringArray(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function normalizePath(value: string): string {
  return value.split(sep).join("/").replace(/^\.\//, "");
}

function normalizePathList(values: string[]): string[] {
  return values.map((value) => normalizePath(value.trim())).filter(Boolean);
}

function matchesPathPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

function normalizeSeverity(value: string | undefined): SecuritySeverity {
  switch (value?.trim().toLowerCase()) {
    case "high":
      return "high";
    case "low":
      return "low";
    default:
      return "medium";
  }
}

function assertInside(root: string, target: string): void {
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error(`Security scan path escapes workspace: ${target}`);
}
