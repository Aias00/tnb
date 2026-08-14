import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSystemPrompt } from "../../src/constants/prompts";
import {
  ASK_USER_QUESTION_TOOL_PROMPT,
  AGENT_TOOL_PROMPT,
  ENTER_PLAN_MODE_TOOL_PROMPT,
  EXIT_PLAN_MODE_TOOL_PROMPT,
  BASH_TOOL_PROMPT,
  EDIT_TOOL_PROMPT,
  GLOB_TOOL_PROMPT,
  GREP_TOOL_PROMPT,
  IMAGE_GENERATE_TOOL_PROMPT,
  IMAGE_SEARCH_TOOL_PROMPT,
  NOTEBOOK_EDIT_TOOL_PROMPT,
  READ_TOOL_PROMPT,
  SKILL_TOOL_PROMPT,
  TODO_WRITE_TOOL_PROMPT,
  WEB_FETCH_TOOL_PROMPT,
  WEB_SEARCH_TOOL_PROMPT,
  WRITE_TOOL_PROMPT,
} from "../../src/constants/tool-prompts";
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWebFetchTool,
  createWriteTool,
} from "../../src/tools/builtins";
import { createWebSearchTool } from "../../src/tools/web-search";
import { createImageSearchTool } from "../../src/tools/image-search";
import { createImageGenerateTool } from "../../src/tools/image-generate";
import { createAskUserQuestionTool, createTodoWriteTool } from "../../src/tools/interaction";
import { createAgentTool } from "../../src/tools/agent";
import { createNotebookEditTool } from "../../src/tools/notebook-edit";
import { PermissionModeState } from "../../src/core/plan-mode";
import { createPlanModeTools } from "../../src/tools/plan-mode";
import {
  loadProjectInstructionFiles,
  loadProjectInstructions,
} from "../../src/services/project-context";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("system prompt", () => {
  test("assembles the complete coding-agent policy around enabled capabilities", () => {
    const prompt = buildSystemPrompt({
      cwd: "/workspace/project",
      model: "test-model",
      toolNames: ["read", "write", "edit", "notebook_edit", "bash", "grep", "glob", "skill"],
      date: "2026-08-09",
      platform: "darwin arm64",
      isGitRepository: true,
      projectInstructions: "Run bun test before reporting completion.",
    });

    for (const heading of [
      "# System",
      "# Doing tasks",
      "# Executing actions with care",
      "# Using your tools",
      "# Git operations",
      "# Tone and style",
      "# Environment",
      "# Project instructions",
    ]) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain("/workspace/project");
    expect(prompt).toContain("test-model");
    expect(prompt).toContain("Run bun test before reporting completion.");
    expect(prompt).toContain("Use `grep` for content search");
    expect(prompt).toContain("Use `skill` when an available skill matches");
    expect(prompt).toContain("Use `notebook_edit` for Jupyter notebook cell changes");
    expect(prompt).not.toContain("Claude Code");
    expect(prompt).not.toContain("Anthropic's official");
    expect(prompt.length).toBeGreaterThan(6_000);
  });

  test("does not advertise tools or git behavior that are unavailable", () => {
    const prompt = buildSystemPrompt({
      cwd: "/tmp/plain",
      model: "model",
      toolNames: ["read"],
      date: "2026-08-09",
      platform: "linux x64",
      isGitRepository: false,
    });

    expect(prompt).not.toContain("Use `grep` for content search");
    expect(prompt).not.toContain("Use `skill` when an available skill matches");
    expect(prompt).not.toContain("# Git operations");
  });
});

describe("project instructions", () => {
  test("loads parent and workspace instruction files from general to specific", async () => {
    const root = await mkdtemp(join(tmpdir(), "tnb-prompts-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "project");
    await mkdir(join(workspace, ".tnb"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "parent agents");
    await writeFile(join(workspace, "CLAUDE.md"), "workspace guidance");
    await writeFile(join(workspace, ".tnb", "instructions.md"), "local guidance");

    const instructions = await loadProjectInstructions(workspace, { stopAt: root });

    expect(instructions).toContain("parent agents");
    expect(instructions).toContain("workspace guidance");
    expect(instructions).toContain("local guidance");
    expect(instructions.indexOf("parent agents")).toBeLessThan(
      instructions.indexOf("local guidance"),
    );

    const files = await loadProjectInstructionFiles(workspace, { stopAt: root });
    expect(files.map((file) => ({ path: file.filePath, type: file.memoryType }))).toEqual([
      { path: join(root, "AGENTS.md"), type: "Project" },
      { path: join(workspace, "CLAUDE.md"), type: "Project" },
      { path: join(workspace, ".tnb", "instructions.md"), type: "Local" },
    ]);
  });
});

describe("tool prompts", () => {
  test("gives every built-in tool a substantive capability-accurate prompt", () => {
    const prompts = [
      READ_TOOL_PROMPT,
      WRITE_TOOL_PROMPT,
      EDIT_TOOL_PROMPT,
      BASH_TOOL_PROMPT,
      GREP_TOOL_PROMPT,
      GLOB_TOOL_PROMPT,
      WEB_FETCH_TOOL_PROMPT,
      WEB_SEARCH_TOOL_PROMPT,
      SKILL_TOOL_PROMPT,
      TODO_WRITE_TOOL_PROMPT,
      ASK_USER_QUESTION_TOOL_PROMPT,
      AGENT_TOOL_PROMPT,
      ENTER_PLAN_MODE_TOOL_PROMPT,
      EXIT_PLAN_MODE_TOOL_PROMPT,
      NOTEBOOK_EDIT_TOOL_PROMPT,
    ];

    for (const prompt of prompts) expect(prompt.length).toBeGreaterThan(180);
    expect(READ_TOOL_PROMPT).toContain("PNG");
    expect(READ_TOOL_PROMPT).toContain("PDF");
    expect(BASH_TOOL_PROMPT).toContain("dedicated tools");
    expect(BASH_TOOL_PROMPT).toContain("run_in_background");
    expect(BASH_TOOL_PROMPT).toContain("pty=true");
    expect(EDIT_TOOL_PROMPT).toContain("exact, unique");
    expect(EDIT_TOOL_PROMPT).not.toContain("replace_all");
    expect(WEB_SEARCH_TOOL_PROMPT).toContain("Sources:");
    expect(SKILL_TOOL_PROMPT).toContain("isolated Agent context");
    expect(NOTEBOOK_EDIT_TOOL_PROMPT).toContain("cell_id");
    expect(NOTEBOOK_EDIT_TOOL_PROMPT).toContain("cell-N");
  });

  test("registers the migrated prompts as the provider-facing descriptions", () => {
    const cwd = process.cwd();
    expect(createReadTool(cwd).description).toBe(READ_TOOL_PROMPT);
    expect(createWriteTool(cwd).description).toBe(WRITE_TOOL_PROMPT);
    expect(createEditTool(cwd).description).toBe(EDIT_TOOL_PROMPT);
    expect(createBashTool(cwd).description).toBe(BASH_TOOL_PROMPT);
    expect(createGrepTool(cwd).description).toBe(GREP_TOOL_PROMPT);
    expect(createGlobTool(cwd).description).toBe(GLOB_TOOL_PROMPT);
    expect(createWebFetchTool().description).toBe(WEB_FETCH_TOOL_PROMPT);
    expect(createWebSearchTool({ apiKey: "test" }).description).toBe(
      WEB_SEARCH_TOOL_PROMPT,
    );
    expect(createImageSearchTool({ apiKey: "test" }).description).toBe(
      IMAGE_SEARCH_TOOL_PROMPT,
    );
    expect(createImageGenerateTool(process.cwd(), { apiKey: "test" }).description).toBe(
      IMAGE_GENERATE_TOOL_PROMPT,
    );
    expect(createTodoWriteTool().description).toBe(TODO_WRITE_TOOL_PROMPT);
    expect(createAskUserQuestionTool().description).toBe(ASK_USER_QUESTION_TOOL_PROMPT);
    expect(createAgentTool({ runAgent: async () => "done" }).description).toStartWith(AGENT_TOOL_PROMPT);
    expect(createNotebookEditTool(cwd).description).toBe(NOTEBOOK_EDIT_TOOL_PROMPT);
    const [enterPlanMode, exitPlanMode] = createPlanModeTools(
      new PermissionModeState("default"),
    );
    expect(enterPlanMode!.description).toBe(ENTER_PLAN_MODE_TOOL_PROMPT);
    expect(exitPlanMode!.description).toBe(EXIT_PLAN_MODE_TOOL_PROMPT);
  });

  test("documents tool parameters in the provider-facing JSON schemas", () => {
    const properties = (tool: { inputSchema: Record<string, unknown> }) =>
      tool.inputSchema.properties as Record<string, { description?: string }>;
    const cwd = process.cwd();

    expect(properties(createReadTool(cwd)).path?.description).toContain("workspace");
    expect(properties(createWriteTool(cwd)).content?.description).toContain("complete");
    expect(properties(createEditTool(cwd)).oldText?.description).toContain("exact");
    expect(properties(createNotebookEditTool(cwd)).cell_id?.description).toContain("cell-N");
    expect(properties(createBashTool(cwd)).command?.description).toContain("shell");
    expect(properties(createWebSearchTool({ apiKey: "test" })).query?.description).toContain(
      "Search query",
    );
  });
});
