import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadSkills,
  parseSkillMarkdown,
  renderSkillPrompt,
} from "../../src/services/skills/loader";

const directories: string[] = [];
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "tnb-skills-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("skill loading", () => {
  test("parses supported frontmatter and markdown instructions", () => {
    expect(
      parseSkillMarkdown(
        [
          "---",
          "name: review-code",
          "description: >",
          "  Review a change and",
          "  report concrete findings.",
          "allowed-tools:",
          "  - read",
          "  - grep",
          "arguments: [target, mode]",
          "argument-hint: <target> [mode]",
          "keywords: [review, audit]",
          "when_to_use: Use for requested reviews.",
          "version: 1.2.3",
          "model: openai/gpt-5",
          "user-invocable: false",
          "context: fork",
          "agent: explore",
          "effort: high",
          "paths:",
          "  - src/**",
          "  - docs/review.md",
          "hooks:",
          "  SessionStart:",
          "    - matcher: startup",
          "      hooks:",
          "        - type: command",
          "          command: printf ready",
          "---",
          "Review $target carefully in $mode mode.",
        ].join("\n"),
        "/skills/review-code/SKILL.md",
      ),
    ).toEqual({
      name: "review-code",
      description: "Review a change and report concrete findings.",
      allowedTools: ["read", "grep"],
      argumentHint: "<target> [mode]",
      argumentNames: ["target", "mode"],
      keywords: ["review", "audit"],
      whenToUse: "Use for requested reviews.",
      version: "1.2.3",
      model: "openai/gpt-5",
      userInvocable: false,
      context: "fork",
      agent: "explore",
      effort: "high",
      paths: ["src", "docs/review.md"],
      hooks: {
        SessionStart: [{
          matcher: "startup",
          hooks: [{ type: "command", command: "printf ready" }],
        }],
      },
      instructions: "Review $target carefully in $mode mode.",
    });
  });

  test("loads the highest-priority duplicate from user, project, then bundled", async () => {
    const root = await temporaryDirectory();
    const userDir = join(root, "user");
    const projectDir = join(root, "project");
    const bundledDir = join(root, "bundled");
    for (const [directory, description] of [
      [userDir, "user version"],
      [projectDir, "project version"],
      [bundledDir, "bundled version"],
    ] as const) {
      await mkdir(join(directory, "review"), { recursive: true });
      await writeFile(
        join(directory, "review", "SKILL.md"),
        `---\nname: review\ndescription: ${description}\n---\nDo work.`,
      );
    }

    const skills = await loadSkills([
      { directory: userDir, source: "user" },
      { directory: projectDir, source: "project" },
      { directory: bundledDir, source: "bundled" },
    ]);

    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe("user version");
    expect(skills[0]?.source).toBe("user");
  });

  test("expands arguments and exposes the skill base directory", () => {
    const prompt = renderSkillPrompt(
      {
        name: "review",
        description: "Review",
        instructions: "Review $target in $mode mode. Extra: $ARGUMENTS[2]. Files live in ${CLAUDE_SKILL_DIR} and ${TNB_SKILL_DIR}.",
        argumentNames: ["target", "mode"],
        baseDir: "/skills/review",
        source: "project",
      },
      'src/main.ts strict optional',
    );

    expect(prompt).toBe(
      "Skill base directory: /skills/review\n\nReview src/main.ts in strict mode. Extra: optional. Files live in /skills/review and /skills/review.",
    );
  });

  test("lists supporting resources without injecting their contents", async () => {
    const root = await temporaryDirectory();
    const skillDir = join(root, "resourceful");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: resourceful\ndescription: Uses references\n---\nRead only what is needed.");
    await writeFile(join(skillDir, "references", "guide.md"), "large private reference body");
    const [skill] = await loadSkills([{ directory: root, source: "user" }]);
    const prompt = renderSkillPrompt(skill!, "");
    expect(skill?.resources).toEqual(["references/guide.md"]);
    expect(prompt).toContain("- references/guide.md");
    expect(prompt).not.toContain("large private reference body");
  });

  test("rejects missing required metadata", () => {
    expect(() =>
      parseSkillMarkdown("---\nname: incomplete\n---\nBody", "/skills/incomplete/SKILL.md"),
    ).toThrow("Skill description is required");
  });
});
