import { describe, expect, test } from "bun:test";

import { parseSseJson } from "../../src/providers/sse";

describe("provider SSE parsing", () => {
  test("parses CRLF boundaries split across chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"value":1}\r'));
        controller.enqueue(encoder.encode('\n\r'));
        controller.enqueue(encoder.encode('\ndata: {"value":2}\n\n'));
        controller.close();
      },
    });

    expect(await collect(parseSseJson(new Response(stream)))).toEqual([{ value: 1 }, { value: 2 }]);
  });

  test("flushes a final SSE frame without a trailing blank line", async () => {
    const response = new Response('data: {"terminal":true}');

    expect(await collect(parseSseJson(response))).toEqual([{ terminal: true }]);
  });

  test("fails a stream that becomes idle after headers", async () => {
    const stream = new ReadableStream<Uint8Array>({ start() {} });

    await expect(collect(parseSseJson(new Response(stream), { idleTimeoutMs: 10 })))
      .rejects.toThrow("idle for 10ms");
  });

  test("preserves multi-line data fields", async () => {
    const response = new Response('data: {"message":\ndata: "hello"}\n\n');

    expect(await collect(parseSseJson(response))).toEqual([{ message: "hello" }]);
  });
});

async function collect(iterator: AsyncGenerator<unknown>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of iterator) values.push(value);
  return values;
}
