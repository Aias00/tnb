import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

import { IMAGE_GENERATE_TOOL_PROMPT } from "../constants/tool-prompts";
import { defineTool } from "../core/tool";
import { currentWorkspaceRoot, type WorkspaceRootSource } from "../core/workspace-state";
import { ProviderHttpError } from "../providers/retry";
import { assertToolPathInsideAllowedRoots, resolveWorkspaceRoot } from "../utils/workspace-path";

type ImageGenerateInput = {
  prompt: string;
  output_path: string;
  size?: "auto" | "1024x1024" | "1024x1536" | "1536x1024";
  quality?: "auto" | "low" | "medium" | "high";
  background?: "auto" | "opaque" | "transparent";
  output_format?: "png" | "webp" | "jpeg";
};

export type ImageGenerateOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
};

export function createImageGenerateTool(
  workspaceRoot: WorkspaceRootSource,
  options: ImageGenerateOptions,
  additionalRoots: () => string[] = () => [],
) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const model = options.model?.trim() || "gpt-image-2";

  return defineTool<ImageGenerateInput, { content: string; attachments: [{ type: "image"; source: { type: "base64"; mediaType: "image/jpeg" | "image/png" | "image/webp"; data: string } }] }>({
    name: "image_generate",
    description: IMAGE_GENERATE_TOOL_PROMPT,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, description: "Detailed image-generation prompt." },
        output_path: { type: "string", minLength: 1, description: "Workspace-relative output file path." },
        size: { type: "string", enum: ["auto", "1024x1024", "1024x1536", "1536x1024"] },
        quality: { type: "string", enum: ["auto", "low", "medium", "high"] },
        background: { type: "string", enum: ["auto", "opaque", "transparent"] },
        output_format: { type: "string", enum: ["png", "webp", "jpeg"] },
      },
      required: ["prompt", "output_path"],
      additionalProperties: false,
    },
    access: "network",
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    permissionRuleContent: ({ output_path }) => output_path,
    validate(input) {
      const value = requireObject(input);
      const prompt = nonEmptyString(value.prompt, "image_generate prompt");
      const outputPath = nonEmptyString(value.output_path, "image_generate output_path");
      const outputFormat = optionalEnum(value.output_format, ["png", "webp", "jpeg"] as const, "output_format") ?? formatFromPath(outputPath);
      const size = optionalEnum(value.size, ["auto", "1024x1024", "1024x1536", "1536x1024"] as const, "size");
      const quality = optionalEnum(value.quality, ["auto", "low", "medium", "high"] as const, "quality");
      const background = optionalEnum(value.background, ["auto", "opaque", "transparent"] as const, "background");
      assertExtension(outputPath, outputFormat);
      return {
        prompt,
        output_path: outputPath,
        ...(size === undefined ? {} : { size }),
        ...(quality === undefined ? {} : { quality }),
        ...(background === undefined ? {} : { background }),
        output_format: outputFormat,
      };
    },
    async execute(input, signal) {
      const root = resolveWorkspaceRoot(currentWorkspaceRoot(workspaceRoot));
      await assertToolPathInsideAllowedRoots(root, input.output_path, "write", additionalRoots());
      const endpoint = imageGenerationEndpoint(options.baseUrl ?? "https://api.openai.com/v1");
      const headers = new Headers(options.headers);
      headers.set("content-type", "application/json");
      if (options.apiKey && !headers.has("authorization")) {
        headers.set("authorization", `Bearer ${options.apiKey}`);
      }
      const response = await fetcher(endpoint, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          model,
          prompt: input.prompt,
          ...(input.size ? { size: input.size } : {}),
          ...(input.quality ? { quality: input.quality } : {}),
          ...(input.background ? { background: input.background } : {}),
          output_format: input.output_format,
          n: 1,
        }),
      });
      if (!response.ok) {
        throw new ProviderHttpError(
          response.status,
          `Image generation request failed (${response.status}): ${await response.text()}`,
          response.headers,
        );
      }
      const result = (await response.json()) as ImageGenerationResponse;
      const encoded = result.data?.[0]?.b64_json;
      if (!encoded) {
        const remoteUrl = result.data?.[0]?.url;
        throw new Error(remoteUrl
          ? `The image provider returned a URL instead of image bytes: ${remoteUrl}`
          : "The image provider returned no generated image data");
      }
      const bytes = decodeBase64(encoded);
      assertImageSignature(bytes, input.output_format ?? "png");
      const target = resolve(root, input.output_path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { signal });
      const mediaType = mediaTypeFor(input.output_format ?? "png");
      const usage = result.usage
        ? `; usage: ${result.usage.input_tokens ?? 0} input, ${result.usage.output_tokens ?? 0} output tokens`
        : "";
      return {
        content: `Generated ${input.output_path} with ${model} (${bytes.byteLength} bytes${usage})`,
        attachments: [{
          type: "image",
          source: { type: "base64", mediaType, data: encoded },
        }],
      };
    },
  });
}

export function imageGenerationEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/images/generations")) return url.toString();
  url.pathname = `${path}${path.endsWith("/v1") ? "" : "/v1"}/images/generations`;
  return url.toString();
}

function formatFromPath(path: string): "png" | "webp" | "jpeg" {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "png";
  if (extension === ".webp") return "webp";
  if (extension === ".jpg" || extension === ".jpeg") return "jpeg";
  throw new Error("image_generate output_path must end in .png, .webp, .jpg, or .jpeg");
}

function assertExtension(path: string, format: "png" | "webp" | "jpeg"): void {
  const actual = formatFromPath(path);
  if (actual !== format) throw new Error(`image_generate output_path extension does not match ${format}`);
}

function mediaTypeFor(format: "png" | "webp" | "jpeg"): "image/png" | "image/webp" | "image/jpeg" {
  return format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("The image provider returned invalid base64 image data");
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 0) throw new Error("The image provider returned an empty image");
  return bytes;
}

function assertImageSignature(bytes: Buffer, format: "png" | "webp" | "jpeg"): void {
  const valid = format === "png"
    ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : format === "jpeg"
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) throw new Error(`The image provider response is not a valid ${format} image`);
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("image_generate input must be an object");
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalEnum<T extends string>(value: unknown, choices: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new Error(`image_generate ${name} must be one of: ${choices.join(", ")}`);
  }
  return value as T;
}

type ImageGenerationResponse = {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
