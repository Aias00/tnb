import { describe, expect, test } from "bun:test";

import type { McpClient } from "../../src/services/mcp/client";
import {
  completeMcpPromptInput,
  createMcpPromptCommands,
  expandMcpPromptInput,
} from "../../src/services/mcp/prompts";

describe("MCP prompt commands", () => {
  test("completes the active prompt argument with prior arguments as context", async () => {
    const calls: unknown[] = [];
    const commands = createMcpPromptCommands("review server", [{
      name: "review-code",
      arguments: [{ name: "target", required: true }, { name: "focus" }],
    }]);
    const client = {
      async completeArgument(ref: unknown, argument: unknown, context: unknown) {
        calls.push({ ref, argument, context });
        return { values: ["security", "correctness"] };
      },
    } as unknown as McpClient;
    const input = "/mcp__review_server__review-code src sec";
    expect(await completeMcpPromptInput(input, commands, { "review server": client })).toEqual({
      values: [
        "/mcp__review_server__review-code src security",
        "/mcp__review_server__review-code src correctness",
      ],
      replaceStart: input.lastIndexOf("sec"),
      replaceEnd: input.length,
    });
    expect(calls).toEqual([{
      ref: { type: "ref/prompt", name: "review-code" },
      argument: { name: "focus", value: "sec" },
      context: { target: "src" },
    }]);
  });

  test("maps positional arguments and expands text into canonical user content", async () => {
    const calls: unknown[] = [];
    const commands = createMcpPromptCommands("review server", [
      {
        name: "review-code",
        arguments: [
          { name: "target", required: true },
          { name: "focus" },
        ],
      },
    ]);
    const client = {
      async getPrompt(name: string, args: Record<string, string>) {
        calls.push({ name, args });
        return {
          messages: [{ role: "user" as const, content: { type: "text", text: "Review src" } }],
        };
      },
    } as unknown as McpClient;

    expect(
      await expandMcpPromptInput(
        "/mcp__review_server__review-code src security",
        commands,
        { "review server": client },
      ),
    ).toEqual([{ type: "text", text: "Review src" }]);
    expect(calls).toEqual([
      { name: "review-code", args: { target: "src", focus: "security" } },
    ]);
  });

  test("preserves supported image and embedded PDF prompt content", async () => {
    const commands = createMcpPromptCommands("media", [{ name: "inspect" }]);
    const client = {
      async getPrompt() {
        return {
          messages: [
            {
              role: "user" as const,
              content: { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
            },
            {
              role: "user" as const,
              content: {
                type: "resource",
                resource: {
                  uri: "file:///reports/design.pdf",
                  mimeType: "application/pdf",
                  blob: "cGRm",
                },
              },
            },
          ],
        };
      },
    } as unknown as McpClient;

    expect(await expandMcpPromptInput("/mcp__media__inspect", commands, { media: client })).toEqual([
      {
        type: "image",
        source: { type: "base64", mediaType: "image/png", data: "aW1hZ2U=" },
      },
      {
        type: "document",
        source: { type: "base64", mediaType: "application/pdf", data: "cGRm" },
        filename: "design.pdf",
      },
    ]);
  });

  test("validates required and excess positional arguments", async () => {
    const commands = createMcpPromptCommands("server", [
      { name: "review", arguments: [{ name: "target", required: true }] },
    ]);
    const client = { getPrompt: async () => ({ messages: [] }) } as unknown as McpClient;

    await expect(
      expandMcpPromptInput("/mcp__server__review", commands, { server: client }),
    ).rejects.toThrow("requires arguments: target");
    await expect(
      expandMcpPromptInput("/mcp__server__review one two", commands, { server: client }),
    ).rejects.toThrow("accepts 1 argument(s)");
  });
});
