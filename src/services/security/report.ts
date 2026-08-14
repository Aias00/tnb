import type { SecurityFinding, SecurityScanResult } from "./scanner";

export type SecurityReportFormat = "text" | "json" | "markdown" | "sarif";

export function renderSecurityReport(result: SecurityScanResult, format: SecurityReportFormat): string {
  if (format === "json") return JSON.stringify(result, null, 2);
  if (format === "sarif") return JSON.stringify(toSarif(result), null, 2);
  if (format === "markdown") return renderMarkdown(result);
  return renderText(result);
}

function renderText(result: SecurityScanResult): string {
  const lines = [
    `Scanned ${result.scannedFiles} file(s); found ${result.findings.length} issue(s).`,
    `Severity: high=${result.summary.severity.high} medium=${result.summary.severity.medium} low=${result.summary.severity.low}`,
  ];
  for (const finding of result.findings) lines.push(formatFinding(finding));
  return lines.join("\n");
}

function renderMarkdown(result: SecurityScanResult): string {
  return [
    "# Security Review",
    "",
    `Scanned ${result.scannedFiles} files and found ${result.findings.length} issues.`,
    "",
    `- High: ${result.summary.severity.high}`,
    `- Medium: ${result.summary.severity.medium}`,
    `- Low: ${result.summary.severity.low}`,
    "",
    ...result.findings.flatMap((finding) => [
      `## ${finding.severity.toUpperCase()} — ${finding.rule}`,
      "",
      `- Location: \`${finding.path}:${finding.line}\``,
      `- Language: ${finding.language ?? "text"}`,
      `- CWE: ${finding.cwe}`,
      `- Confidence: ${finding.confidence}`,
      "",
      finding.message,
      "",
      `Remediation: ${finding.remediation}`,
      "",
    ]),
  ].join("\n");
}

function toSarif(result: SecurityScanResult): Record<string, unknown> {
  const rules = [...new Map(result.findings.map((finding) => [finding.rule, finding])).values()];
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: { driver: {
        name: "tnb security review",
        informationUri: "https://github.com/tnb/tnb",
        rules: rules.map((finding) => ({
          id: finding.rule,
          shortDescription: { text: finding.message },
          help: { text: finding.remediation },
          properties: { category: finding.category, cwe: finding.cwe },
        })),
      } },
      results: result.findings.map((finding) => ({
        ruleId: finding.rule,
        level: finding.severity === "high" ? "error" : finding.severity === "medium" ? "warning" : "note",
        message: { text: finding.message },
        locations: [{ physicalLocation: {
          artifactLocation: { uri: finding.path },
          region: { startLine: finding.line },
        } }],
        properties: {
          severity: finding.severity,
          confidence: finding.confidence,
          language: finding.language,
          cwe: finding.cwe,
          remediation: finding.remediation,
        },
      })),
    }],
  };
}

function formatFinding(finding: SecurityFinding): string {
  const source = finding.source === "builtin" ? "" : ` [${finding.source}]`;
  return `${finding.severity.toUpperCase()} ${finding.path}:${finding.line} ${finding.rule}${source} (${finding.cwe}) — ${finding.message}`;
}
