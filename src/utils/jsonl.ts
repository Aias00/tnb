function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function parseJsonlBuffer<T>(buffer: Buffer): T[] {
  const length = buffer.length;
  let start = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  const results: T[] = [];
  while (start < length) {
    let end = buffer.indexOf(0x0a, start);
    if (end === -1) end = length;
    const line = buffer.toString("utf8", start, end).trim();
    start = end + 1;
    if (!line) continue;
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      // Transcript recovery keeps independently valid append-only records.
    }
  }
  return results;
}

function parseJsonlString<T>(input: string): T[] {
  const value = stripBom(input);
  const results: T[] = [];
  let start = 0;
  while (start < value.length) {
    let end = value.indexOf("\n", start);
    if (end === -1) end = value.length;
    const line = value.substring(start, end).trim();
    start = end + 1;
    if (!line) continue;
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      // Transcript recovery keeps independently valid append-only records.
    }
  }
  return results;
}

export function parseJsonl<T>(input: string | Buffer): T[] {
  return typeof input === "string" ? parseJsonlString<T>(input) : parseJsonlBuffer<T>(input);
}
