import { describe, expect, test } from "bun:test";

import type { PermissionChecker } from "../../src/core/permissions";
import type { AskUser, UserQuestion } from "../../src/tools/interaction";
import { McpRequestError } from "../../src/services/mcp/client";
import { createMcpElicitationHandler } from "../../src/services/mcp/elicitation";

const allow: PermissionChecker = async () => ({ behavior: "allow" });

describe("MCP elicitation", () => {
  test("collects and validates a flat form with primitive and enum fields", async () => {
    const answers = ["alice", "21", "Blue", "Red, Green", "Skip"];
    const questions: UserQuestion[] = [];
    const askUser: AskUser = async (question) => {
      questions.push(structuredClone(question));
      return answers.shift()!;
    };
    const handler = createMcpElicitationHandler({
      serverName: "profile",
      authorize: allow,
      askUser,
    });

    expect(await handler({
      message: "Complete your public profile",
      requestedSchema: {
        type: "object",
        required: ["username", "age", "color", "tags"],
        properties: {
          username: { type: "string", minLength: 3, maxLength: 20 },
          age: { type: "integer", minimum: 18, maximum: 120 },
          color: {
            type: "string",
            oneOf: [
              { const: "#f00", title: "Red" },
              { const: "#00f", title: "Blue" },
            ],
          },
          tags: {
            type: "array",
            items: { type: "string", enum: ["Red", "Green", "Blue"] },
            minItems: 1,
            maxItems: 2,
          },
          nickname: { type: "string" },
        },
      },
    }, new AbortController().signal)).toEqual({
      action: "accept",
      content: {
        username: "alice",
        age: 21,
        color: "#00f",
        tags: ["Red", "Green"],
      },
    });
    expect(questions).toHaveLength(5);
    expect(questions[2]?.options.map((option) => option.label)).toEqual(["Red", "Blue"]);
    expect(questions[3]?.multiSelect).toBe(true);
  });

  test("returns decline when the user rejects disclosure", async () => {
    const handler = createMcpElicitationHandler({
      serverName: "fixture",
      authorize: async () => ({ behavior: "deny", message: "denied" }),
      askUser: async () => "unused",
    });
    expect(await handler({
      message: "Need a name",
      requestedSchema: { type: "object", properties: { name: { type: "string" } } },
    }, new AbortController().signal)).toEqual({ action: "decline" });
  });

  test("exposes protocol-shaped lifecycle context and applies hook overrides", async () => {
    const contexts: unknown[] = [];
    const handler = createMcpElicitationHandler({
      serverName: "profile",
      authorize: allow,
      async onRequest(context) {
        contexts.push(context);
        return { action: "accept", content: { name: "from-request-hook" } };
      },
      async onResult(context, result) {
        contexts.push({ context, result });
        return { action: "accept", content: { name: "from-result-hook" } };
      },
    });
    const requestedSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    };

    expect(await handler({
      message: "Need a name",
      requestedSchema,
    }, new AbortController().signal)).toEqual({
      action: "accept",
      content: { name: "from-result-hook" },
    });
    expect(contexts[0]).toEqual({
      serverName: "profile",
      message: "Need a name",
      mode: "form",
      requestedSchema,
    });
  });

  test("returns cancel when an accepted form cannot complete", async () => {
    const handler = createMcpElicitationHandler({
      serverName: "fixture",
      authorize: allow,
      askUser: async () => {
        throw new Error("dialog closed");
      },
    });
    expect(await handler({
      message: "Need a name",
      requestedSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
    }, new AbortController().signal)).toEqual({ action: "cancel" });
  });

  test("shows validated URL elicitations for approval without collecting secrets", async () => {
    const approvals: unknown[] = [];
    const handler = createMcpElicitationHandler({
      serverName: "billing",
      authorize: async (_tool, input) => {
        approvals.push(input);
        return { behavior: "allow" };
      },
    });
    expect(await handler({
      mode: "url",
      url: "https://payments.example.test/checkout?id=1",
      message: "Complete checkout in your browser",
    }, new AbortController().signal)).toEqual({ action: "accept" });
    expect(approvals[0]).toMatchObject({
      server: "billing",
      mode: "url",
      host: "payments.example.test",
    });
  });

  test("rejects sensitive form fields and unsafe URL forms", async () => {
    const handler = createMcpElicitationHandler({
      serverName: "fixture",
      authorize: allow,
    });
    for (const params of [
      {
        message: "Send credentials",
        requestedSchema: {
          type: "object",
          properties: { accessToken: { type: "string" } },
        },
      },
      {
        mode: "url",
        elicitationId: "bad",
        url: "https://user:secret@example.test/",
        message: "Open this URL",
      },
    ]) {
      try {
        await handler(params, new AbortController().signal);
        throw new Error("Expected invalid elicitation request");
      } catch (error) {
        expect(error).toBeInstanceOf(McpRequestError);
        expect((error as McpRequestError).code).toBe(-32602);
      }
    }
  });
});
