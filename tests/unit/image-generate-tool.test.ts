import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createImageGenerateTool,
  imageGenerationEndpoint,
} from "../../src/tools/image-generate";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("image_generate tool", () => {
  test("uses the configured OpenAI-compatible endpoint and saves verified bytes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tnb-image-"));
    temporaryDirectories.push(workspace);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    let requestBody: Record<string, unknown> | undefined;
    let requestUrl: string | undefined;
    const tool = createImageGenerateTool(workspace, {
      apiKey: "image-key",
      baseUrl: "https://images.example/v1",
      model: "custom-image-model",
      headers: { "x-tenant": "team-a" },
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer image-key");
        expect(headers.get("x-tenant")).toBe("team-a");
        return Response.json({
          data: [{ b64_json: png.toString("base64") }],
          usage: { input_tokens: 12, output_tokens: 34 },
        });
      },
    });

    const output = await tool.execute(tool.validate({
      prompt: "A clear technical diagram",
      output_path: "assets/diagram.png",
      quality: "high",
    }), new AbortController().signal);

    expect(requestUrl).toBe("https://images.example/v1/images/generations");
    expect(requestBody).toMatchObject({
      model: "custom-image-model",
      prompt: "A clear technical diagram",
      quality: "high",
      output_format: "png",
      n: 1,
    });
    expect(await readFile(join(workspace, "assets/diagram.png"))).toEqual(png);
    expect(output.content).toContain("12 input, 34 output tokens");
    expect(output.attachments[0]?.source.mediaType).toBe("image/png");
  });

  test("rejects extension mismatch and paths outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tnb-image-"));
    temporaryDirectories.push(workspace);
    const tool = createImageGenerateTool(workspace, { apiKey: "key" });
    expect(() => tool.validate({
      prompt: "test",
      output_path: "image.jpg",
      output_format: "png",
    })).toThrow("extension does not match");
    await expect(tool.execute(tool.validate({
      prompt: "test",
      output_path: "../image.png",
    }), new AbortController().signal)).rejects.toThrow("outside the workspace");
  });

  test("normalizes base URLs and accepts a complete endpoint", () => {
    expect(imageGenerationEndpoint("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/images/generations");
    expect(imageGenerationEndpoint("https://gateway.example/api")).toBe("https://gateway.example/api/v1/images/generations");
    expect(imageGenerationEndpoint("https://gateway.example/v1/images/generations")).toBe("https://gateway.example/v1/images/generations");
  });
});
