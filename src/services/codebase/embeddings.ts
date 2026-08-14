export type CodebaseEmbeddingProvider = {
  readonly id: string;
  embed(inputs: string[], signal?: AbortSignal): Promise<number[][]>;
};

export function createOpenAIEmbeddingProvider(options: {
  id: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
}): CodebaseEmbeddingProvider {
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/embeddings`;
  return {
    id: `${options.id}:${options.model}`,
    async embed(inputs, signal) {
      if (!inputs.length) return [];
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...options.headers,
        },
        body: JSON.stringify({ model: options.model, input: inputs }),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Embedding request failed (${response.status}): ${detail.slice(0, 500)}`);
      }
      const body = await response.json() as {
        data?: Array<{ index?: number; embedding?: unknown }>;
      };
      if (!Array.isArray(body.data) || body.data.length !== inputs.length) {
        throw new Error("Embedding response did not contain one vector per input");
      }
      const ordered = [...body.data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
      return ordered.map((entry) => {
        if (!Array.isArray(entry.embedding) || entry.embedding.some((value) => typeof value !== "number")) {
          throw new Error("Embedding response contains an invalid vector");
        }
        return entry.embedding as number[];
      });
    },
  };
}
