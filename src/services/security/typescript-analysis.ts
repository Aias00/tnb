import { relative } from "node:path";
import { API } from "typescript/unstable/async";
import {
  SyntaxKind,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isVariableDeclaration,
  type Expression,
  type FunctionLikeDeclaration,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";

import type { SecurityFinding } from "./scanner";
import { resolveTypeScriptServerPath } from "../codebase/typescript-runtime";

type Sink = {
  names: Set<string>;
  rule: string;
  severity: SecurityFinding["severity"];
  cwe: string;
  category: string;
  message: string;
  remediation: string;
};

type SinkSummary = {
  name: string;
  parameterIndexes: number[];
  sink: Sink;
  path: string;
  line: number;
};

const SINKS: Sink[] = [
  {
    names: new Set(["exec", "execSync", "spawn", "spawnSync", "system", "popen", "eval"]),
    rule: "ast-request-to-command",
    severity: "high",
    cwe: "CWE-78",
    category: "injection",
    message: "A command execution API receives a value derived from external input.",
    remediation: "Use a fixed executable with validated argv values and avoid shell evaluation.",
  },
  {
    names: new Set(["query", "execute", "raw", "execSql"]),
    rule: "ast-request-to-sql",
    severity: "high",
    cwe: "CWE-89",
    category: "injection",
    message: "A database execution API receives a value derived from external input.",
    remediation: "Use a prepared statement and bind every external value as a parameter.",
  },
  {
    names: new Set(["readFile", "readFileSync", "writeFile", "writeFileSync", "open", "sendFile", "createReadStream", "createWriteStream"]),
    rule: "ast-request-to-filesystem",
    severity: "medium",
    cwe: "CWE-22",
    category: "path-traversal",
    message: "A filesystem API receives a path derived from external input.",
    remediation: "Canonicalize beneath an approved root and reject paths that escape it.",
  },
];

export async function scanTypeScriptDataFlow(
  root: string,
  absolutePaths: string[],
): Promise<SecurityFinding[]> {
  if (!absolutePaths.length) return [];
  const findings: SecurityFinding[] = [];
  const api = new API({ cwd: root, tsserverPath: await resolveTypeScriptServerPath() });
  try {
    const snapshot = await api.updateSnapshot({ openFiles: absolutePaths });
    const sourceFiles: Array<{ path: string; sourceFile: SourceFile }> = [];
    for (const path of absolutePaths) {
      const project = await snapshot.getDefaultProjectForFile(path);
      const sourceFile = project ? await project.program.getSourceFile(path) : undefined;
      if (sourceFile) sourceFiles.push({ path, sourceFile });
    }
    const summaries = sourceFiles.flatMap(({ path, sourceFile }) => collectSinkSummaries(root, path, sourceFile));
    for (const { path, sourceFile } of sourceFiles) findings.push(...scanSourceFile(root, path, sourceFile, summaries));
  } finally {
    api.close();
  }
  return deduplicate(findings);
}

function scanSourceFile(root: string, path: string, sourceFile: SourceFile, summaries: SinkSummary[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = sourceFile.text.split(/\r?\n/);
  const scanScope = (scope: Node, seeded: Set<string>) => {
    const tainted = new Set(seeded);
    const visit = (node: Node): void => {
      if (node !== scope && isFunctionLikeDeclaration(node)) {
        scanFunction(node);
        return;
      }
      if (isVariableDeclaration(node) && isIdentifier(node.name) && node.initializer && isTainted(node.initializer, tainted)) {
        tainted.add(node.name.text);
      } else if (
        isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken &&
        isIdentifier(node.left) && isTainted(node.right, tainted)
      ) {
        tainted.add(node.left.text);
      }
      if (isCallExpression(node)) {
        const called = callName(node.expression);
        const sink = called ? SINKS.find((candidate) => candidate.names.has(called)) : undefined;
        const taintedArgument = sink && node.arguments.some((argument) => isTainted(argument, tainted));
        if (sink && taintedArgument) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          findings.push({
            rule: sink.rule,
            severity: sink.severity,
            cwe: sink.cwe,
            path: relative(root, path).replaceAll("\\", "/"),
            line: position.line + 1,
            message: sink.message,
            evidence: (lines[position.line] ?? "").trim().slice(0, 500),
            source: "builtin",
            category: sink.category,
            confidence: hasDirectExternalSource(node) ? "high" : "medium",
            remediation: sink.remediation,
          });
        }
        for (const summary of called ? summaries.filter((candidate) => candidate.name === called) : []) {
          if (!summary.parameterIndexes.some((index) => node.arguments[index] && isTainted(node.arguments[index]!, tainted))) continue;
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          findings.push({
            rule: `ast-call-chain-${summary.sink.rule}`,
            severity: summary.sink.severity,
            cwe: summary.sink.cwe,
            path: relative(root, path).replaceAll("\\", "/"),
            line: position.line + 1,
            message: `External input reaches ${summary.sink.category} sink through ${summary.name} (${summary.path}:${summary.line}).`,
            evidence: (lines[position.line] ?? "").trim().slice(0, 500),
            source: "builtin",
            category: summary.sink.category,
            confidence: "medium",
            remediation: summary.sink.remediation,
          });
        }
      }
      node.forEachChild(visit);
    };
    visit(scope);
  };
  const scanFunction = (node: FunctionLikeDeclaration) => {
    const seeded = new Set<string>();
    for (const parameter of node.parameters) {
      if (isParameterDeclaration(parameter) && parameter.name && isIdentifier(parameter.name) && isExternalName(parameter.name.text)) {
        seeded.add(parameter.name.text);
      }
    }
    scanScope(node, seeded);
  };
  scanScope(sourceFile, new Set());
  return findings;
}

function collectSinkSummaries(root: string, path: string, sourceFile: SourceFile): SinkSummary[] {
  const summaries: SinkSummary[] = [];
  const visit = (node: Node): void => {
    if ((isFunctionDeclaration(node) || isMethodDeclaration(node)) && node.name && isIdentifier(node.name) && node.body) {
      const parameters = node.parameters.map((parameter) => parameter.name && isIdentifier(parameter.name) ? parameter.name.text : undefined);
      const hits = new Map<Sink, Set<number>>();
      const inspect = (child: Node): void => {
        if (child !== node && isFunctionLikeDeclaration(child)) return;
        if (isCallExpression(child)) {
          const sinkName = callName(child.expression);
          const sink = sinkName ? SINKS.find((candidate) => candidate.names.has(sinkName)) : undefined;
          if (sink) {
            for (let index = 0; index < parameters.length; index += 1) {
              const parameter = parameters[index];
              if (parameter && child.arguments.some((argument) => referencesIdentifier(argument, parameter))) {
                let indexes = hits.get(sink);
                if (!indexes) {
                  indexes = new Set<number>();
                  hits.set(sink, indexes);
                }
                indexes.add(index);
              }
            }
          }
        }
        child.forEachChild(inspect);
      };
      inspect(node.body);
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      for (const [sink, indexes] of hits) {
        summaries.push({
          name: node.name.text,
          parameterIndexes: [...indexes],
          sink,
          path: relative(root, path).replaceAll("\\", "/"),
          line,
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return summaries;
}

function referencesIdentifier(node: Node, name: string): boolean {
  if (isIdentifier(node) && node.text === name) return true;
  let found = false;
  node.forEachChild((child) => {
    if (!found && referencesIdentifier(child, name)) found = true;
  });
  return found;
}

function isTainted(node: Node, tainted: Set<string>): boolean {
  if (isIdentifier(node)) return tainted.has(node.text) || isExternalName(node.text);
  if (isPropertyAccessExpression(node)) {
    return isTainted(node.expression, tainted) || isExternalProperty(node);
  }
  if (isElementAccessExpression(node)) return isTainted(node.expression, tainted) || isTainted(node.argumentExpression, tainted);
  if (isCallExpression(node)) {
    const name = callName(node.expression);
    if (name && ["getParameter", "getHeader", "prompt", "question"].includes(name)) return true;
  }
  let result = false;
  node.forEachChild((child) => {
    if (!result && isTainted(child, tainted)) result = true;
  });
  return result;
}

function isExternalProperty(node: Node): boolean {
  if (!isPropertyAccessExpression(node)) return false;
  const text = node.getText();
  return /^(?:req|request)\.(?:query|params|body|headers|cookies)\b/.test(text) ||
    /^(?:process\.argv|Deno\.args)\b/.test(text);
}

function hasDirectExternalSource(node: Node): boolean {
  return /(?:req|request)\.(?:query|params|body|headers|cookies)|process\.argv|Deno\.args/.test(node.getText());
}

function isExternalName(name: string): boolean {
  return ["req", "request", "input", "params", "argv", "userInput"].includes(name);
}

function callName(expression: Expression): string | undefined {
  if (isIdentifier(expression)) return expression.text;
  if (isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function deduplicate(findings: SecurityFinding[]): SecurityFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.rule}:${finding.path}:${finding.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
