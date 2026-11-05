import { expect, test } from "bun:test";
import React from "react";
import chalk from "chalk";
import { Markdown } from "../../src/ui/markdown";
import { renderToScreen } from "../../src/ui/ink/render-to-screen";
import { cellAt } from "../../src/ui/ink/screen";

function keywordHasStyle(markdown: string): boolean {
  const { screen, height } = renderToScreen(<Markdown>{markdown}</Markdown>, 80);
  for (let row = 0; row < height; row++) {
    const cells = Array.from({ length: screen.width }, (_, column) => cellAt(screen, column, row));
    const text = cells.map(cell => cell?.char ?? " ").join("");
    const column = text.indexOf("const sample");
    if (column >= 0) return cells[column]!.styleId !== screen.emptyStyleId;
  }
  throw new Error("Code block text is missing from the rendered output");
}

test("unlabelled, plain-text and unsupported code blocks do not guess syntax colors", () => {
  const previous = chalk.level;
  chalk.level = 1;
  try {
    for (const language of ["", "text", "plaintext", "unknown-language"]) {
      const style = keywordHasStyle(`\`\`\`${language}\nconst sample = 'value'; // comment\n\`\`\``);
      expect(style).toBe(false);
    }
  } finally { chalk.level = previous; }
});

test("explicit supported languages retain syntax highlighting", () => {
  const previous = chalk.level;
  chalk.level = 1;
  try {
    const style = keywordHasStyle("```javascript\nconst sample = 'value'; // comment\n```");
    expect(style).toBe(true);
  } finally { chalk.level = previous; }
});

test("tables align CJK columns and render inline formatting instead of raw Markdown", () => {
  const { renderToString } = require("../../src/ui/ink/index");
  const frame = renderToString(<Markdown>{[
    "| 层面 | 技术 |",
    "| --- | --- |",
    "| 语言 | **TypeScript** |",
    "| CLI | `Commander` |",
  ].join("\n")}</Markdown>, { columns: 50 });
  expect(frame).toContain("TypeScript");
  expect(frame).toContain("Commander");
  expect(frame).not.toContain("**");
  expect(frame).not.toContain("`Commander`");
  const rows = frame.split("\n").filter((line: string) => /层面|语言|CLI/.test(line));
  const { stringWidth } = require("../../src/ui/ink/stringWidth");
  const dividers = rows.map((line: string) => stringWidth(line.slice(0, line.indexOf("│", 1))));
  expect(new Set(dividers).size).toBe(1);
  expect(frame).toContain("─");
});

test("narrow tables wrap cell content within terminal width", () => {
  const { renderToString } = require("../../src/ui/ink/index");
  const { stringWidth } = require("../../src/ui/ink/stringWidth");
  const frame = renderToString(<Markdown>{"| 层面 | 技术 |\n| --- | --- |\n| 运行时 | Bun supports TypeScript and JavaScript |"}</Markdown>, { columns: 26 });
  expect(frame).toContain("运行时");
  expect(frame).toContain("JavaScript");
  for (const line of frame.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(26);
});
