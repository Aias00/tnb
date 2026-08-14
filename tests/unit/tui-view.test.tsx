import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToString } from "../../src/ui/ink/index";

import { TuiView } from "../../src/ui/tui";
import { createTuiState, reduceTuiState } from "../../src/ui/tui-state";
import { createTranscriptEntry } from "../../src/ui/transcript/model";

describe("Ink TUI view", () => {
  test("renders transcript, streaming text, tool progress, input, and status", () => {
    let state = reduceTuiState(createTuiState("test-model", "default"), {
      type: "submit",
      text: "Inspect package.json",
    });
    state = reduceTuiState(state, {
      type: "model-event",
      event: { type: "text", index: 0, text: "Reading **project metadata**" },
    });
    state = reduceTuiState(state, {
      type: "tool-start",
      id: "call-1",
      name: "read",
      input: { path: "package.json" },
    });

    const frame = renderToString(
      <TuiView
        state={state}
        input="next instruction"
        cursor={4}
        columns={100}
      />,
    );

    expect(frame).not.toContain("tnb");
    expect(frame).toContain("test-model");
    expect(frame).toContain("Inspect package.json");
    expect(frame).toContain("Reading");
    expect(frame).toContain("project metadata");
    expect(frame).toContain("Read");
    expect(frame).toContain("Running");
    expect(frame).toContain("next instruction");
  });

  test("renders current MCP progress while a turn is active", () => {
    const state = reduceTuiState(createTuiState("test-model", "default"), {
      type: "submit",
      text: "Run remote tool",
    });
    const frame = renderToString(
      <TuiView
        state={state}
        input=""
        cursor={0}
        columns={100}
        mcpActivity={{
          type: "progress",
          serverName: "database",
          progressToken: "call-1",
          progress: 4,
          total: 10,
          message: "Scanning rows",
        }}
      />,
    );

    expect(frame).toContain("MCP database 4/10");
    expect(frame).toContain("Scanning rows");
  });

  test("shows provider-reported context utilization in the status line", () => {
    let state = createTuiState("test-model", "default", { contextWindowTokens: 200_000 });
    state = reduceTuiState(state, {
      type: "model-event",
      event: {
        type: "usage",
        usage: {
          inputTokens: 70_000,
          outputTokens: 2_000,
          cacheReadInputTokens: 20_000,
          cacheCreationInputTokens: 0,
        },
      },
    });
    const frame = renderToString(<TuiView state={state} input="" cursor={0} columns={100} />);
    expect(frame).toContain("ctx 45%");
    expect(frame).toContain("↑90,000");
  });

  test("keeps chrome fixed and clips old transcript content to the terminal height", () => {
    const state = {
      ...createTuiState("test-model", "default"),
      transcript: Array.from({ length: 20 }, (_, index) => createTranscriptEntry(index, {
        kind: "system" as const,
        text: `message-${index}`,
        tone: "info" as const,
      })),
      nextTranscriptSequence: 20,
    };
    const frame = renderToString(
      <TuiView
        state={state}
        input="latest input"
        cursor={12}
        columns={80}
        rows={12}
      />,
      { columns: 80 },
    );

    expect(frame.split("\n")).toHaveLength(12);
    expect(frame).not.toContain("tnb");
    expect(frame).toContain("message-19");
    expect(frame).not.toContain("message-0");
    expect(frame).toContain("latest input");
    expect(frame).toContain("enter send");
  });

  test("renders the latest transcript rows by default", () => {
    const state = {
      ...createTuiState("test-model", "default"),
      transcript: Array.from({ length: 12 }, (_, index) => createTranscriptEntry(index, {
        kind: "system" as const,
        text: `message-${index}`,
        tone: "info" as const,
      })),
      nextTranscriptSequence: 12,
    };
    const frame = renderToString(
      <TuiView
        state={state}
        input=""
        cursor={0}
        columns={80}
        rows={12}
      />,
      { columns: 80 },
    );

    expect(frame).toContain("message-11");
    expect(frame).not.toContain("message-0");
  });

  test("includes completed tool rows in the row viewport", () => {
    const state = {
      ...createTuiState("test-model", "default"),
      transcript: Array.from({ length: 10 }, (_, index) => createTranscriptEntry(index, {
        kind: "tool" as const,
        toolUseId: `tool-${index}`,
        name: `bash-${index}`,
        input: { command: `command-${index}` },
        status: "completed" as const,
        output: `output-${index}`,
      }, `tool-${index}`)),
      nextTranscriptSequence: 10,
    };
    const frame = renderToString(
      <TuiView
        state={state}
        input=""
        cursor={0}
        columns={80}
        rows={12}
      />,
      { columns: 80 },
    );

    expect(frame).toContain("command-9");
    expect(frame).not.toContain("bash-0");
  });

  test("renders a keyboard-selectable permission dialog", () => {
    const frame = renderToString(
      <TuiView
        state={createTuiState("test-model", "default")}
        input=""
        cursor={0}
        columns={80}
        permission={{
          tool: { name: "bash", risk: "execute", isReadOnly: () => false },
          input: { command: "bun test" },
          message: "bash requires approval",
          suggestedRule: "Bash(bun test)",
        }}
        permissionSelection="deny"
      />,
    );

    expect(frame).toContain("Permission required");
    expect(frame).toContain("bun test");
    expect(frame).toContain("Allow once");
    expect(frame).toContain("Allow for session");
    expect(frame).toContain("Deny");
  });

  test("renders the complete plan in an exit approval dialog", () => {
    const plan = "1. Inspect the current API.\n2. Implement the change.\n3. Run focused tests.";
    const frame = renderToString(
      <TuiView
        state={createTuiState("test-model", "plan")}
        input=""
        cursor={0}
        columns={100}
        permission={{
          tool: {
            name: "exit_plan_mode",
            risk: "read",
            isReadOnly: () => true,
          },
          input: { plan },
          message: "exit_plan_mode requires approval",
        }}
      />,
    );

    expect(frame).toContain("Inspect the current API");
    expect(frame).toContain("Implement the change");
    expect(frame).toContain("Run focused tests");
  });

  test("renders todos and a keyboard-selectable user question", () => {
    const state = reduceTuiState(createTuiState("test-model", "default"), {
      type: "tool-start",
      id: "todo-1",
      name: "todo_write",
      input: {
        todos: [
          { content: "Run tests", activeForm: "Running tests", status: "in_progress" },
          { content: "Build", activeForm: "Building", status: "pending" },
        ],
      },
    });
    const frame = renderToString(
      <TuiView
        state={state}
        input=""
        cursor={0}
        columns={90}
        question={{
          header: "Library",
          question: "Which library should we use?",
          options: [
            { label: "Existing", description: "Use the current dependency" },
            { label: "Custom", description: "Write a local implementation" },
          ],
          multiSelect: false,
        }}
        questionSelection={1}
      />,
    );

    expect(frame).toContain("Tasks");
    expect(frame).toContain("Running tests");
    expect(frame).toContain("Which library should we use?");
    expect(frame).toContain("Existing");
    expect(frame).toContain("Custom");
    expect(frame).toContain("Other");
  });

  test("renders a keyboard-selectable management page", () => {
    const frame = renderToString(
      <TuiView
        state={createTuiState("test-model", "default")}
        input=""
        cursor={0}
        columns={100}
        management={{
          kind: "sessions",
          title: "Recent sessions",
          description: "Select a conversation to resume.",
          items: [
            {
              id: "session-a",
              label: "Provider work",
              description: "session-a · 12 messages",
              command: "/resume session-a",
              active: true,
            },
            {
              id: "session-b",
              label: "MCP work",
              command: "/resume session-b",
            },
          ],
        }}
        managementSelection={1}
      />,
    );

    expect(frame).toContain("Recent sessions");
    expect(frame).toContain("Provider work");
    expect(frame).toContain("MCP work");
    expect(frame).toContain("↑/↓ select");
    expect(frame).not.toContain("enter send");
  });

  test("anchors a management page at the top without a transcript spacer", () => {
    const frame = renderToString(
      <TuiView
        state={createTuiState("test-model", "default")}
        input=""
        cursor={0}
        columns={100}
        rows={24}
        management={{
          kind: "sessions",
          title: "Resume session",
          items: [{ id: "session-a", label: "Provider work", command: "/resume session-a" }],
        }}
      />,
      { columns: 100 },
    );

    const lines = frame.split("\n");
    expect(lines[0]?.trim()).not.toBe("");
    expect(lines.slice(0, 3).join("\n")).toContain("Resume session");
  });

  test("renders the selected session's historical user inputs", () => {
    const frame = renderToString(
      <TuiView
        state={createTuiState("test-model", "default")}
        input=""
        cursor={0}
        columns={100}
        management={{
          kind: "sessions",
          title: "Resume session",
          items: [
            {
              id: "session-a",
              label: "Provider work",
              command: "/resume session-a",
              preview: ["Configure the provider", "Verify streaming output"],
            },
            {
              id: "session-b",
              label: "MCP work",
              command: "/resume session-b",
              preview: ["This belongs to the other session"],
            },
          ],
        }}
        managementSelection={0}
      />,
    );

    expect(frame).toContain("Session input history");
    expect(frame).toContain("Configure the provider");
    expect(frame).toContain("Verify streaming output");
    expect(frame).not.toContain("This belongs to the other session");
  });

  test("keeps the selected session and its input preview visible in a long list", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      id: `session-${index}`,
      label: `Session ${index}`,
      command: `/resume session-${index}`,
      preview: [`Historical input ${index}`],
    }));
    const frame = renderToString(
      <TuiView
        state={createTuiState("test-model", "default")}
        input=""
        cursor={0}
        columns={100}
        rows={20}
        management={{ kind: "sessions", title: "Resume session", items }}
        managementSelection={10}
      />,
    );

    expect(frame).toContain("Session 10");
    expect(frame).toContain("Historical input 10");
    expect(frame).not.toContain("Session 0");
  });

  test("renders full selected-session transcript and browser actions", () => {
    const frame = renderToString(
      <TuiView
        state={createTuiState("test-model", "default")}
        input=""
        cursor={0}
        columns={120}
        rows={28}
        management={{
          kind: "sessions",
          title: "Resume session",
          items: [{
            id: "session-a",
            label: "Provider work",
            command: "/resume session-a",
            transcriptPreview: [
              createTranscriptEntry(0, { kind: "user", text: "Configure Yuanjing" }),
              createTranscriptEntry(1, { kind: "assistant", text: "Provider configured" }),
              createTranscriptEntry(2, { kind: "tool", toolUseId: "read-1", name: "read", input: { path: "models.json" }, status: "completed", output: "{}" }),
            ],
          }],
        }}
        sessionAction={{ type: "rename", input: "New provider title" }}
      />,
      { columns: 120 },
    );
    expect(frame).toContain("Conversation preview");
    expect(frame).toContain("Configure Yuanjing");
    expect(frame).toContain("Provider configured");
    expect(frame).toContain("Read(models.json)");
    expect(frame).toContain("R rename · F fork · D delete");
    expect(frame).toContain("New title: New provider title");
  });

  test("renders resource-specific management actions", () => {
    const pluginFrame = renderToString(<TuiView
      state={createTuiState("test-model", "default")} input="" cursor={0} columns={100}
      management={{ kind: "plugins", title: "Plugins", items: [{ id: "review", label: "review", command: "/plugins disable review", active: true }] }}
    />);
    const mcpFrame = renderToString(<TuiView
      state={createTuiState("test-model", "default")} input="" cursor={0} columns={100}
      management={{ kind: "mcp", title: "MCP servers", items: [{ id: "github", label: "github", command: "/mcp disable github", active: true, badges: ["oauth", "authorized"] }] }}
    />);
    const marketplaceFrame = renderToString(<TuiView
      state={createTuiState("test-model", "default")} input="" cursor={0} columns={100}
      management={{ kind: "marketplace", title: "Plugin Marketplace", items: [{ id: "catalog:review", label: "review · 1.0.0", command: "/marketplace install review" }] }}
    />);
    const doctorFrame = renderToString(<TuiView
      state={createTuiState("test-model", "default")} input="" cursor={0} columns={100}
      management={{ kind: "doctor", title: "Doctor", items: [{ id: "sandbox", label: "sandbox", command: "/doctor", badges: ["warning"], details: ["sandbox unavailable"] }] }}
    />);
    expect(pluginFrame).toContain("R reload · U update · D remove");
    expect(pluginFrame).toContain("Enter toggle");
    expect(mcpFrame).toContain("R reload · A auth · O logout");
    expect(mcpFrame).toContain("Enter toggle");
    expect(marketplaceFrame).toContain("R refresh");
    expect(marketplaceFrame).toContain("Enter install");
    expect(doctorFrame).toContain("R rerun");
    expect(doctorFrame).toContain("Enter rerun");
  });

  test("renders a selected-item detail panel for management resources", () => {
    const frame = renderToString(
      <TuiView
        state={createTuiState("test-model", "default")}
        input=""
        cursor={0}
        columns={120}
        rows={24}
        management={{
          kind: "plugins",
          title: "Plugins",
          description: "Browse plugin capabilities.",
          items: [
            {
              id: "review",
              label: "review",
              description: "0.3.0 · user · active · auto/on-change · Code review helpers",
              command: "/plugins disable review",
              active: true,
              badges: ["plugin", "active", "reversible"],
              details: [
                "Tools: review, security_scan",
                "Skills: review, security-review",
              ],
              inspectCommand: "/plugins show review",
            },
          ],
        }}
      />,
      { columns: 120 },
    );

    expect(frame).toContain("Selected item");
    expect(frame).toContain("plugin");
    expect(frame).toContain("reversible");
    expect(frame).toContain("Primary action");
    expect(frame).toContain("/plugins disable review");
    expect(frame).toContain("Inspect");
    expect(frame).toContain("/plugins show review");
    expect(frame).toContain("Tools: review, security_scan");
    expect(frame).toContain("Skills: review, security-review");
  });

  test("renders doctor and marketplace detail panels", () => {
    const doctorFrame = renderToString(
      <TuiView
        state={createTuiState("test-model", "default")}
        input=""
        cursor={0}
        columns={120}
        rows={24}
        management={{
          kind: "doctor",
          title: "Doctor",
          description: "One or more diagnostics require attention.",
          items: [{
            id: "sandbox",
            label: "sandbox",
            description: "sandbox unavailable",
            command: "/doctor",
            badges: ["warning"],
            details: ["sandbox-exec missing"],
          }],
        }}
      />,
      { columns: 120 },
    );
    const marketplaceFrame = renderToString(
      <TuiView
        state={createTuiState("test-model", "default")}
        input=""
        cursor={0}
        columns={120}
        rows={24}
        management={{
          kind: "marketplace",
          title: "Plugin Marketplace",
          description: "Enter installs the selected plugin.",
          items: [{
            id: "Community:security-review",
            label: "security-review · 1.1.0",
            description: "Community · Security helpers",
            command: "/marketplace install security-review",
            badges: ["security", "cap:skill", "cap:builtin-tool"],
            details: [
              "When to use: Use for sandbox and permissions work.",
              "Capabilities: skill, builtin-tool",
              "Repository: file:///tmp/security-review",
            ],
          }],
        }}
      />,
      { columns: 120 },
    );

    expect(doctorFrame).toContain("Diagnostic requires attention");
    expect(doctorFrame).toContain("sandbox-exec missing");
    expect(marketplaceFrame).toContain("cap:builtin-tool");
    expect(marketplaceFrame).toContain("When to use: Use for sandbox and permissions work.");
    expect(marketplaceFrame).toContain("/marketplace install security-review");
  });

  test("renders specialized tool status cards for management-oriented tools", () => {
    const state = {
      ...createTuiState("test-model", "default"),
      transcript: [
        createTranscriptEntry(0, {
          kind: "tool",
          toolUseId: "agent-1",
          name: "agent",
          input: { description: "Inspect provider fallbacks", subagent_type: "explore" },
          status: "completed",
          output: "Background agent started with task #7",
        }),
        createTranscriptEntry(1, {
          kind: "tool",
          toolUseId: "skill-1",
          name: "skill",
          input: { name: "review", arguments: "src/providers" },
          status: "completed",
          output: "Loaded review skill",
        }),
        createTranscriptEntry(2, {
          kind: "tool",
          toolUseId: "mcp-1",
          name: "mcp__github__search_code",
          input: { query: "ToolExecutionEvent" },
          status: "running",
          progress: { progress: 2, progressTotal: 4, message: "Scanning repository" },
        }),
        createTranscriptEntry(3, {
          kind: "tool",
          toolUseId: "web-1",
          name: "web_search",
          input: { query: "LSP diagnostics" },
          status: "completed",
          output: "1. https://example.com/lsp\n2. https://example.com/diagnostics",
        }),
        createTranscriptEntry(4, {
          kind: "tool",
          toolUseId: "notebook-1",
          name: "notebook_edit",
          input: { notebook_path: "/repo/demo.ipynb", cell_id: "cell-7", edit_mode: "replace", new_source: "print('ok')" },
          status: "completed",
          output: "Notebook updated",
        }),
        createTranscriptEntry(5, {
          kind: "tool",
          toolUseId: "lsp-1",
          name: "lsp_diagnostics",
          input: { path: "src/ui/app.tsx" },
          status: "completed",
          output: JSON.stringify([
            { severity: "error", message: "Missing semicolon" },
            { severity: "warning", message: "Unused variable" },
          ]),
        }),
        createTranscriptEntry(6, {
          kind: "tool",
          toolUseId: "task-1",
          name: "task_create",
          input: { subject: "Add regression coverage" },
          status: "completed",
          output: "Task #14 created: Add regression coverage",
        }),
        createTranscriptEntry(7, {
          kind: "tool",
          toolUseId: "team-1",
          name: "send_message",
          input: { recipient: "reviewer", message: "Check TUI details" },
          status: "completed",
          output: "Message msg-7 delivered to reviewer",
        }),
        createTranscriptEntry(8, {
          kind: "tool",
          toolUseId: "workflow-1",
          name: "workflow",
          input: {
            action: "run",
            description: "Parallel verification",
            max_concurrency: 2,
            steps: [{ id: "tests", description: "Run tests", prompt: "Run tests" }],
          },
          status: "completed",
          output: "{\"id\":\"run-9\",\"status\":\"running\"}",
        }),
        createTranscriptEntry(9, {
          kind: "tool",
          toolUseId: "image-1",
          name: "image_generate",
          input: { prompt: "tool schema diagram", outputPath: "/tmp/tool-schema.png" },
          status: "completed",
          output: "Image generated at /tmp/tool-schema.png",
        }),
        createTranscriptEntry(10, {
          kind: "tool",
          toolUseId: "edit-1",
          name: "edit",
          input: { path: "src/ui/app.tsx", oldText: "old line\nsame line", newText: "new line\nsame line" },
          status: "completed",
          output: "Applied edit",
        }),
        createTranscriptEntry(11, {
          kind: "tool",
          toolUseId: "mcp-auth-1",
          name: "mcp_auth",
          input: { server: "github" },
          status: "completed",
          output: "Authorized MCP server github",
        }),
      ],
      nextTranscriptSequence: 12,
    };
    const frame = renderToString(
      <TuiView
        state={state}
        input=""
        cursor={0}
        columns={120}
        rows={40}
        verboseTranscript
      />,
      { columns: 120 },
    );

    expect(frame).toContain("MCP server");
    expect(frame).toContain("Web query");
    expect(frame).toContain("Notebook cell");
    expect(frame).toContain("Diagnostics");
    expect(frame).toContain("Task update");
    expect(frame).toContain("Team message");
    expect(frame).toContain("Workflow run");
    expect(frame).toContain("Image output");
    expect(frame).toContain("Patch preview");
    expect(frame).toContain("MCP authorization");
    expect(frame).toContain("1 error");
    expect(frame).toContain("1 warning");
  });

  test("renders PTY and background task controls with output preview", () => {
    const frame = renderToString(<TuiView
      state={createTuiState("test-model", "default")} input="" cursor={0} columns={110} rows={24}
      shellPanel
      shellSelection={1}
      shellInput="yes"
      shellRuntimes={[
        { kind: "background", taskId: "bash_123", pid: 111, command: "bun test", status: "running", output: "tests running", outputPath: "/tmp/bash_123.log" },
        { kind: "pty", pid: 222, command: "npm init", alive: true, cols: 80, rows: 24, screen: "Proceed? (y/n)" },
      ]}
    />);
    expect(frame).toContain("Background tasks & PTY sessions");
    expect(frame).toContain("bash_123 · running · bun test");
    expect(frame).toContain("PTY 222 · running · npm init");
    expect(frame).toContain("Proceed? (y/n)");
    expect(frame).toContain("Input: yes");
    expect(frame).toContain("I send PTY input · K stop");
  });
});
