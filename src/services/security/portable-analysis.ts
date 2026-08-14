export type PortableSourceFile = {
  path: string;
  language: string;
  lines: string[];
};

export type PortableFlowFinding = {
  rule: string;
  severity: "high" | "medium";
  cwe: string;
  path: string;
  line: number;
  message: string;
  evidence: string;
  category: string;
  confidence: "medium";
  remediation: string;
  language: string;
};

type FunctionSummary = {
  language: string;
  name: string;
  parameters: string[];
  body: Array<{ text: string; line: number }>;
  sinks: Array<{ rule: PortableRule; parameterPositions: number[] }>;
};

type PortableRule = {
  rule: string;
  severity: "high" | "medium";
  cwe: string;
  category: string;
  sink: RegExp;
  message: string;
  remediation: string;
};

const EXTERNAL_INPUT = /(?:\b(?:req\.(?:query|params|body|headers|cookies)|request\.(?:args|form|json)|process\.argv|Deno\.args|r\.(?:URL\.Query|FormValue)|request\.getParameter|Request\.(?:Query|Form|RouteValues)|params\s*\[)|\$_(?:GET|POST|REQUEST|COOKIE)\b)/i;

const RULES: PortableRule[] = [
  {
    rule: "syntax-call-chain-request-to-shell", severity: "high", cwe: "CWE-78", category: "injection",
    sink: /(?:\b(?:exec|execSync|system|popen|spawn|spawnSync)\s*\(|Runtime\.getRuntime\(\)\.exec\s*\(|subprocess\.(?:run|call|Popen|check_output)\s*\(|exec\.Command\s*\(|Process\.Start\s*\()/,
    message: "Request-controlled data reaches a command-execution sink through a project function.",
    remediation: "Use a fixed executable, separate argv values, and validate arguments at the trust boundary.",
  },
  {
    rule: "syntax-call-chain-request-to-sql", severity: "high", cwe: "CWE-89", category: "injection",
    sink: /\b(?:query|execute|raw|execSql|prepareStatement)\s*\(/i,
    message: "Request-controlled data reaches a database sink through a project function.",
    remediation: "Use a parameterized statement and bind untrusted values separately.",
  },
  {
    rule: "syntax-call-chain-request-to-file", severity: "medium", cwe: "CWE-22", category: "path-traversal",
    sink: /\b(?:readFile|readFileSync|writeFile|writeFileSync|open|sendFile|createReadStream|createWriteStream|ReadFile|WriteFile|Open|OpenFile|readAllBytes|GetFile|OpenRead|OpenWrite)\s*\(/,
    message: "Request-controlled data reaches a filesystem sink through a project function.",
    remediation: "Canonicalize beneath an approved root and reject paths that escape it.",
  },
];

export function scanPortableDataFlow(files: readonly PortableSourceFile[]): PortableFlowFinding[] {
  const summaries = files.flatMap(extractSummaries);
  const findings: PortableFlowFinding[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    for (let index = 0; index < file.lines.length; index += 1) {
      const line = file.lines[index]!;
      EXTERNAL_INPUT.lastIndex = 0;
      if (!EXTERNAL_INPUT.test(line)) continue;
      for (const summary of summaries) {
        if (summary.language !== file.language) continue;
        const argumentList = callArguments(line, summary.name);
        if (argumentList === undefined) continue;
        EXTERNAL_INPUT.lastIndex = 0;
        if (!EXTERNAL_INPUT.test(argumentList)) continue;
        for (const sink of summary.sinks) {
          if (!sink.parameterPositions.some((position) => argumentContainsExternalInput(argumentList, position))) continue;
          const key = `${sink.rule.rule}:${file.path}:${index + 1}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            rule: sink.rule.rule,
            severity: sink.rule.severity,
            cwe: sink.rule.cwe,
            path: file.path,
            line: index + 1,
            message: sink.rule.message,
            evidence: line.trim(),
            category: sink.rule.category,
            confidence: "medium",
            remediation: sink.rule.remediation,
            language: file.language,
          });
        }
      }
    }
  }
  return findings;
}

function extractSummaries(file: PortableSourceFile): FunctionSummary[] {
  if (!["python", "go", "java", "csharp", "kotlin", "rust", "php"].includes(file.language)) return [];
  const summaries: FunctionSummary[] = [];
  for (let index = 0; index < file.lines.length; index += 1) {
    const definition = parseDefinition(file.language, file.lines[index]!);
    if (!definition) continue;
    const body = collectBody(file.language, file.lines, index);
    const sinks = RULES.flatMap((rule) => {
      const parameterPositions = definition.parameters.flatMap((parameter, position) =>
        parameterReachesSink(parameter, body, rule.sink) ? [position] : []
      );
      return parameterPositions.length ? [{ rule, parameterPositions }] : [];
    });
    if (sinks.length) summaries.push({ language: file.language, ...definition, body, sinks });
  }
  return summaries;
}

function parseDefinition(language: string, line: string): Pick<FunctionSummary, "name" | "parameters"> | undefined {
  const pattern = language === "python"
    ? /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/
    : language === "go"
      ? /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)/
      : language === "rust"
        ? /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/
        : language === "php"
          ? /^\s*(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+&?([A-Za-z_]\w*)\s*\(([^)]*)\)/
          : /^\s*(?:(?:public|protected|private|internal|static|final|abstract|synchronized|native|override|open|suspend)\s+)*(?:[\w<>?,.\[\]]+\s+)+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:\{|=>|throws\b)/;
  const match = pattern.exec(line);
  if (!match?.[1]) return undefined;
  return { name: match[1], parameters: parseParameters(match[2] ?? "", language) };
}

function parseParameters(raw: string, language: string): string[] {
  return raw.split(",").flatMap((entry) => {
    const value = entry.trim().replace(/=.*/, "").trim();
    if (!value) return [];
    if (language === "python" || language === "rust" || language === "php") {
      const name = /^\s*[&*]*\$?([A-Za-z_]\w*)/.exec(value)?.[1];
      return name && !["self", "cls", "this"].includes(name) ? [name] : [];
    }
    const identifiers = value.match(/[A-Za-z_]\w*/g) ?? [];
    const name = language === "go" ? identifiers[0] : identifiers.at(-1);
    return name && !["self", "this"].includes(name) ? [name] : [];
  });
}

function collectBody(language: string, lines: readonly string[], definitionLine: number): Array<{ text: string; line: number }> {
  if (language === "python") {
    const indent = leadingWhitespace(lines[definitionLine]!);
    const body: Array<{ text: string; line: number }> = [];
    for (let index = definitionLine; index < lines.length; index += 1) {
      const text = lines[index]!;
      if (index > definitionLine && text.trim() && leadingWhitespace(text) <= indent) break;
      body.push({ text, line: index + 1 });
    }
    return body;
  }
  const body: Array<{ text: string; line: number }> = [];
  let depth = 0;
  let opened = false;
  for (let index = definitionLine; index < lines.length; index += 1) {
    const text = lines[index]!;
    body.push({ text, line: index + 1 });
    for (const character of text) {
      if (character === "{") { depth += 1; opened = true; }
      else if (character === "}") depth -= 1;
    }
    if (opened && depth <= 0) break;
  }
  return body;
}

function parameterReachesSink(parameter: string, body: readonly { text: string }[], sink: RegExp): boolean {
  const tainted = new Set([parameter]);
  for (const { text } of body) {
    const assigned = assignedName(text);
    if (assigned && containsIdentifier(text.slice(text.indexOf("=") + 1), tainted)) tainted.add(assigned);
    sink.lastIndex = 0;
    if (sink.test(text) && containsIdentifier(text, tainted)) return true;
  }
  return false;
}

function callArguments(line: string, name: string): string | undefined {
  const match = new RegExp(`\\b${escapeRegex(name)}\\s*\\((.*)\\)`).exec(line);
  return match?.[1];
}

function argumentContainsExternalInput(argumentsText: string, position: number): boolean {
  const argument = splitArguments(argumentsText)[position];
  if (!argument) return false;
  EXTERNAL_INPUT.lastIndex = 0;
  return EXTERNAL_INPUT.test(argument);
}

function splitArguments(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if ("([{<".includes(character)) depth += 1;
    else if (")]}>".includes(character)) depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function assignedName(line: string): string | undefined {
  const left = /^(.*?)\s*(?::=|=(?!=|>))/.exec(line)?.[1];
  return left?.match(/[A-Za-z_]\w*/g)?.at(-1);
}

function containsIdentifier(line: string, identifiers: ReadonlySet<string>): boolean {
  for (const identifier of identifiers) if (new RegExp(`\\b${escapeRegex(identifier)}\\b`).test(line)) return true;
  return false;
}

function leadingWhitespace(line: string): number {
  return /^\s*/.exec(line)?.[0].replaceAll("\t", "    ").length ?? 0;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
