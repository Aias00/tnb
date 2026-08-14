import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { parseSkillMarkdown, type LoadedSkill } from "./loader";

const BUNDLED_ROOT = resolveBundledRoot();

let cachedBundledSkills: LoadedSkill[] | undefined;

export function bundledSkills(): LoadedSkill[] {
  if (!cachedBundledSkills) cachedBundledSkills = loadBundledSkills();
  return cachedBundledSkills.map((skill) => structuredClone(skill));
}

function loadBundledSkills(): LoadedSkill[] {
  const loaded = new Map<string, LoadedSkill>();
  for (const entry of readdirSync(BUNDLED_ROOT, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const baseDir = join(BUNDLED_ROOT, entry.name);
    const markdown = readFileSync(join(baseDir, "SKILL.md"), "utf8");
    const skill = parseSkillMarkdown(markdown, join(baseDir, "SKILL.md"));
    const key = skill.name.toLowerCase();
    if (loaded.has(key)) continue;
    const resources = listBundledSkillResources(baseDir);
    loaded.set(key, {
      ...skill,
      ...(resources.length ? { resources } : {}),
      baseDir,
      source: "bundled",
    });
  }
  return [...loaded.values()];
}

function listBundledSkillResources(baseDir: string, currentDir = baseDir): string[] {
  const resources: string[] = [];
  for (const entry of readdirSync(currentDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      resources.push(...listBundledSkillResources(baseDir, path));
      continue;
    }
    if (!entry.isFile()) {
      try {
        if (statSync(path).isDirectory()) resources.push(...listBundledSkillResources(baseDir, path));
      } catch (error) {
        throw new Error(`Bundled skill resource is unreadable: ${path}`, { cause: error });
      }
      continue;
    }
    if (currentDir === baseDir && entry.name === "SKILL.md") continue;
    resources.push(relative(baseDir, path).replaceAll("\\", "/"));
  }
  return resources;
}

function resolveBundledRoot(): string {
  const sourceRoot = join(import.meta.dir, "bundled");
  if (existsSync(sourceRoot)) return sourceRoot;
  const executableRoot = join(dirname(process.execPath), "skills", "bundled");
  if (existsSync(executableRoot)) return executableRoot;
  throw new Error(`Bundled skill resources are missing: expected ${sourceRoot} or ${executableRoot}`);
}
