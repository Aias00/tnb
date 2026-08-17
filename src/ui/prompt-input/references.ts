import type { PastedContent } from "./types";

export type PromptReference = {
  id: number;
  type: "text" | "image";
  start: number;
  end: number;
  text: string;
};

export function getPastedTextRefNumLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) ?? []).length;
}

export function formatPastedTextRef(id: number, numLines: number): string {
  return numLines === 0 ? `[Pasted text #${id}]` : `[Pasted text #${id} +${numLines} lines]`;
}

export function formatImageRef(id: number): string {
  return `[Image #${id}]`;
}

export function parsePromptReferences(input: string): PromptReference[] {
  const pattern = /\[(Pasted text|Image) #(\d+)(?: \+\d+ lines)?\]/g;
  return [...input.matchAll(pattern)].flatMap((match) => {
    const id = Number(match[2]);
    if (!Number.isSafeInteger(id) || id <= 0 || match.index === undefined) return [];
    return [{
      id,
      type: match[1] === "Image" ? "image" as const : "text" as const,
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    }];
  });
}

export function expandPromptReferences(
  input: string,
  contents: Record<number, PastedContent>,
): { expanded: string; images: Array<Extract<PastedContent, { type: "image" }>> } {
  const references = parsePromptReferences(input);
  let expanded = input;
  const images = new Map<number, Extract<PastedContent, { type: "image" }>>();
  for (let index = references.length - 1; index >= 0; index -= 1) {
    const reference = references[index]!;
    const content = contents[reference.id];
    if (!content || content.type !== reference.type) continue;
    if (content.type === "text") {
      expanded = `${expanded.slice(0, reference.start)}${content.content}${expanded.slice(reference.end)}`;
    } else if (!content.missing) {
      images.set(content.id, content);
    }
  }
  return { expanded, images: [...images.values()].sort((left, right) => left.id - right.id) };
}

export function atomicReferenceAt(input: string, offset: number): PromptReference | undefined {
  return parsePromptReferences(input).find((reference) => offset > reference.start && offset < reference.end);
}
