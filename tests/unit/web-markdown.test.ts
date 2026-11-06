import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { marked } from "marked";
import { markdownRenderer, markdownParser } from "../../src/plugins/web/assets";
class Element {
  children: Element[] = []; className = ""; href?: string; target?: string; rel?: string;
  constructor(readonly tag: string, readonly value = "") {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  get text(): string { return this.value + this.children.map(child => child.text).join(""); }
}
const render = (source: string): Element => runInNewContext(markdownRenderer + "\nrenderMarkdown(source)", { marked, source, document: { createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text) } });
const walk = (node: Element): Element[] => [node, ...node.children.flatMap(walk)];
test("browser Markdown renders tables, lists and code while keeping HTML and unsafe URLs inert", () => {
  expect(markdownParser).toContain("marked");
  const root = render('# Title\n\n| A | B |\n|---|---|\n| one | two |\n\n- item\n\n```js\n<script>alert(1)</script>\n```\n\n<script>globalThis.pwned=true</script>\n\n[x](javascript:alert%281%29) [safe](https://example.com) ![secret](https://example.com/track)');
  const all = walk(root); expect(all.some(node => node.tag === "table")).toBe(true); expect(all.some(node => node.tag === "ul")).toBe(true);
  expect(all.filter(node => node.tag === "script" || node.tag === "img")).toHaveLength(0);
  expect(all.filter(node => node.tag === "a").map(node => node.href)).toEqual(["https://example.com"]);
  expect(root.text).toContain("globalThis.pwned=true"); expect(root.text).toContain("<script>alert(1)</script>");
});
