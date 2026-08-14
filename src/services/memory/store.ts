import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

import { projectSessionDirectory } from "../session/storage";

const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;

export class AutoMemoryStore {
  readonly directory: string;
  readonly indexPath: string;
  readonly #configDir: string;
  enabled: boolean;
  #index = "";

  private constructor(options: {
    configDir: string;
    directory: string;
    enabled: boolean;
  }) {
    this.#configDir = options.configDir;
    this.directory = options.directory;
    this.indexPath = join(options.directory, "MEMORY.md");
    this.enabled = options.enabled;
  }

  static async create(options: {
    configDir: string;
    cwd: string;
    enabled?: boolean | undefined;
    directory?: string | undefined;
    env: Record<string, string | undefined>;
  }): Promise<AutoMemoryStore> {
    const disabledByEnvironment = truthy(options.env.TNB_DISABLE_AUTO_MEMORY);
    const directory = options.directory
      ? validateMemoryDirectory(options.directory)
      : join(projectSessionDirectory(options.configDir, options.cwd), "memory");
    const store = new AutoMemoryStore({
      configDir: options.configDir,
      directory,
      enabled: !disabledByEnvironment && options.enabled !== false,
    });
    if (store.enabled) await store.reload();
    return store;
  }

  async reload(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      this.#index = truncateIndex(await readFile(this.indexPath, "utf8"));
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.#index = "";
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await writeUserSetting(this.#configDir, "autoMemoryEnabled", enabled);
    this.enabled = enabled;
    if (enabled) await this.reload();
  }

  summary(): string {
    if (!this.enabled) return `Auto memory is disabled.\nPath: ${this.directory}`;
    return [
      "Auto memory is enabled.",
      `Path: ${this.directory}`,
      `Index: ${this.indexPath}`,
      "",
      this.#index || "MEMORY.md is empty.",
    ].join("\n");
  }

  prompt(): string {
    if (!this.enabled) return "";
    return `# Auto memory

You have persistent project-scoped memory at \`${this.directory}\`. The directory already exists. Use the normal read, write, and edit tools with absolute paths in this directory; do not use shell commands merely to inspect or create it.

Save information that remains useful in future conversations: stable user preferences, explicit corrections, project decisions and their rationale, or external references that cannot be recovered from the repository. Do not save secrets, transient task progress, facts easily derived from code, speculative conclusions, or duplicate entries. If the user explicitly asks you to remember or forget something, update memory during the current turn.

Store each topic in a kebab-case Markdown file with frontmatter fields \`name\`, \`description\`, and \`metadata.type\` (one of \`user\`, \`feedback\`, \`project\`, or \`reference\`). Keep \`MEMORY.md\` as a concise index only. Each index entry is one line under roughly 150 characters: \`- [Title](file.md) — retrieval hint\`. Update or remove stale entries instead of accumulating contradictions.

## MEMORY.md

${this.#index || "The memory index is empty."}`;
  }
}

function truncateIndex(content: string): string {
  const trimmed = content.trim();
  const lineLimited = trimmed.split("\n").slice(0, MAX_INDEX_LINES).join("\n");
  if (Buffer.byteLength(lineLimited, "utf8") <= MAX_INDEX_BYTES) return lineLimited;
  const bytes = Buffer.from(lineLimited, "utf8").subarray(0, MAX_INDEX_BYTES);
  return bytes.toString("utf8").replace(/[^\n]*$/, "").trimEnd() +
    "\n\n> WARNING: MEMORY.md was truncated; keep the index concise and move detail into topic files.";
}

function validateMemoryDirectory(value: string): string {
  const expanded = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  const path = normalize(resolve(expanded)).replace(new RegExp(`${escapeRegex(sep)}+$`), "");
  if (!isAbsolute(path) || path.length < 3 || path === homedir() || path.includes("\0")) {
    throw new Error("autoMemoryDirectory must be a safe absolute directory below a project or configuration root");
  }
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

async function writeUserSetting(configDir: string, key: string, value: unknown): Promise<void> {
  const path = join(configDir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Settings must be an object: ${path}`);
    }
    settings = parsed as Record<string, unknown>;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  settings[key] = value;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
