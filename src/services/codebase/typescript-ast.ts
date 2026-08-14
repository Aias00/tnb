import { API } from "typescript/unstable/async";
import {
  isArrowFunction,
  isBindingElement,
  isBreakStatement,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isContinueStatement,
  isEnumDeclaration,
  isExportDeclaration,
  isExportSpecifier,
  isExternalModuleReference,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportClause,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportSpecifier,
  isInterfaceDeclaration,
  isLabeledStatement,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNamespaceImport,
  isNewExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  type Expression,
  type Identifier,
  type Node,
  type PropertyName,
  type SourceFile,
  type StringLiteral,
  type VariableDeclaration,
} from "typescript/unstable/ast";

import type { CodebaseSymbol } from "./index";
import { resolveTypeScriptServerPath } from "./typescript-runtime";

export type TypeScriptSemanticInfo = {
  symbols: CodebaseSymbol[];
  imports: string[];
  references: string[];
  calls: string[];
};

export async function analyzeTypeScriptFiles(
  root: string,
  paths: string[],
): Promise<Map<string, TypeScriptSemanticInfo>> {
  const results = new Map<string, TypeScriptSemanticInfo>();
  if (!paths.length) return results;
  const api = new API({ cwd: root, tsserverPath: await resolveTypeScriptServerPath() });
  try {
    const snapshot = await api.updateSnapshot({ openFiles: paths });
    for (const path of paths) {
      const project = await snapshot.getDefaultProjectForFile(path);
      const sourceFile = project ? await project.program.getSourceFile(path) : undefined;
      if (sourceFile) results.set(path, analyzeSourceFile(sourceFile));
    }
  } finally {
    api.close();
  }
  return results;
}

export function analyzeSourceFile(sourceFile: SourceFile): TypeScriptSemanticInfo {
  const symbols: CodebaseSymbol[] = [];
  const imports = new Set<string>();
  const references = new Set<string>();
  const calls = new Set<string>();
  const declarations = new Set<Identifier>();

  const addSymbol = (node: Node, name: Identifier | StringLiteral | undefined, kind: CodebaseSymbol["kind"]) => {
    if (!name) return;
    if (isIdentifier(name)) declarations.add(name);
    const symbolName = name.text;
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const signature = declarationSignature(node, sourceFile);
    symbols.push({ name: symbolName, kind, line, signature, tokens: identifierTokens(`${symbolName} ${signature}`) });
  };

  for (const statement of sourceFile.statements) {
    if (isFunctionDeclaration(statement)) addSymbol(statement, statement.name, "function");
    else if (isClassDeclaration(statement)) addSymbol(statement, statement.name, "class");
    else if (isInterfaceDeclaration(statement)) addSymbol(statement, statement.name, "interface");
    else if (isTypeAliasDeclaration(statement)) addSymbol(statement, statement.name, "type");
    else if (isEnumDeclaration(statement)) addSymbol(statement, statement.name, "enum");
  }

  const visit = (node: Node): void => {
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      if (node.moduleSpecifier && isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
    } else if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression && isStringLiteral(expression)) imports.add(expression.text);
    }

    if (isFunctionDeclaration(node) && node.parent !== sourceFile) addSymbol(node, node.name, "function");
    else if (isMethodDeclaration(node)) addSymbol(node, propertyName(node.name), "function");
    else if (isMethodSignatureDeclaration(node)) addSymbol(node, propertyName(node.name), "function");
    else if (isClassDeclaration(node) && node.parent !== sourceFile) addSymbol(node, node.name, "class");
    else if (isInterfaceDeclaration(node) && node.parent !== sourceFile) addSymbol(node, node.name, "interface");
    else if (isTypeAliasDeclaration(node) && node.parent !== sourceFile) addSymbol(node, node.name, "type");
    else if (isEnumDeclaration(node) && node.parent !== sourceFile) addSymbol(node, node.name, "enum");
    else if (isVariableDeclaration(node) && isIdentifier(node.name)) {
      declarations.add(node.name);
      if (isCallableInitializer(node.initializer)) addSymbol(node, node.name, "function");
      else if (isTopLevelVariable(node)) addSymbol(node, node.name, "variable");
    } else if (isParameterDeclaration(node) && node.name && isIdentifier(node.name)) declarations.add(node.name);
    else if (isBindingElement(node) && node.name && isIdentifier(node.name)) declarations.add(node.name);

    if (isCallExpression(node) || isNewExpression(node)) {
      const name = calledName(node.expression);
      if (name) calls.add(name);
    }
    if (isIdentifier(node) && !declarations.has(node) && !isNonReferenceIdentifier(node)) references.add(node.text);
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return {
    symbols: deduplicateSymbols(symbols),
    imports: [...imports],
    references: [...references],
    calls: [...calls],
  };
}

function propertyName(name: PropertyName): Identifier | StringLiteral | undefined {
  return isIdentifier(name) || isStringLiteral(name) ? name : undefined;
}

function isCallableInitializer(node: Expression | undefined): boolean {
  return Boolean(node && (isArrowFunction(node) || isFunctionExpression(node) || isClassExpression(node)));
}

function isTopLevelVariable(node: VariableDeclaration): boolean {
  return node.parent.parent.parent.kind === node.getSourceFile().kind;
}

function calledName(expression: Node): string | undefined {
  if (isIdentifier(expression)) return expression.text;
  if (isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function isNonReferenceIdentifier(node: Identifier): boolean {
  const parent = node.parent;
  return (
    (isPropertyAccessExpression(parent) && parent.name === node) ||
    (isPropertyAssignment(parent) && parent.name === node && parent.initializer !== node) ||
    isImportSpecifier(parent) || isExportSpecifier(parent) || isImportClause(parent) || isNamespaceImport(parent) ||
    isLabeledStatement(parent) || isBreakStatement(parent) || isContinueStatement(parent)
  );
}

function declarationSignature(node: Node, sourceFile: SourceFile): string {
  const text = node.getText(sourceFile).split(/\r?\n/, 1)[0]?.trim() ?? "";
  return text.length <= 220 ? text : `${text.slice(0, 219)}…`;
}

function identifierTokens(value: string): string[] {
  return [...new Set(value
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[^A-Za-z0-9_]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length >= 2))];
}

function deduplicateSymbols(symbols: CodebaseSymbol[]): CodebaseSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.kind}:${symbol.name}:${symbol.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
