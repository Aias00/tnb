import type { ModelRequest } from "../../providers/types";

/** Conservative text-request estimate, not a provider tokenizer. Includes JSON/schema overhead. */
export function estimateRequestTokens(request: ModelRequest): number {
  return Buffer.byteLength(JSON.stringify(request), "utf8") + 32 * request.messages.length;
}

export function requestInputLimit(contextWindow: number, maxOutputTokens: number): number {
  if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxOutputTokens)
    || contextWindow < 1024 || maxOutputTokens < 1 || maxOutputTokens >= contextWindow) {
    throw new Error("Invalid model context/output capacity");
  }
  return contextWindow - maxOutputTokens - Math.max(256, Math.min(4096, Math.ceil(contextWindow * 0.05)));
}

/** Slice only at Unicode code-point boundaries. */
export function prefixWithin(text: string, fits: (prefix: string) => boolean): string {
  let low = 0; let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(text.slice(0, middle))) low = middle;
    else high = middle - 1;
  }
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low--;
  return text.slice(0, low);
}
