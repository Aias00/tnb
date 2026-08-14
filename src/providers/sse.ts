import { ProviderHttpError } from "./retry";

export async function* parseSseJson(response: Response): AsyncGenerator<unknown> {
  if (!response.ok) {
    const detail = await response.text();
    throw new ProviderHttpError(
      response.status,
      `Provider request failed (${response.status}): ${detail}`,
      response.headers,
    );
  }
  if (!response.body) throw new Error("Provider response has no body");

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      yield JSON.parse(data);
    }
  }
}
