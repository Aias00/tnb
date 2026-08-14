import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type WorktreeSessionState = {
  originalCwd: string;
  worktreePath: string;
  worktreeName: string;
  worktreeBranch: string;
  originalHead: string;
};

export class WorkspaceState {
  readonly originalCwd: string;
  #cwd: string;
  #worktree: WorktreeSessionState | undefined;
  #additionalRoots: string[] = [];

  constructor(cwd: string) {
    this.originalCwd = cwd;
    this.#cwd = cwd;
  }

  current = (): string => this.#cwd;

  get worktree(): WorktreeSessionState | undefined {
    return this.#worktree ? structuredClone(this.#worktree) : undefined;
  }

  additionalRoots = (): string[] => [...this.#additionalRoots];

  roots = (): string[] => [this.#cwd, ...this.#additionalRoots];

  addRoot(path: string): string {
    const canonical = realpathSync(resolve(this.#cwd, path));
    if (!statSync(canonical).isDirectory()) throw new Error(`Workspace root is not a directory: ${canonical}`);
    if (canonical === realpathSync(resolve(this.#cwd))) return canonical;
    if (!this.#additionalRoots.includes(canonical)) this.#additionalRoots.push(canonical);
    return canonical;
  }

  enter(worktree: WorktreeSessionState): void {
    if (this.#worktree) throw new Error("This session is already using an isolated worktree");
    this.#worktree = structuredClone(worktree);
    this.#cwd = worktree.worktreePath;
  }

  restore(worktree: WorktreeSessionState | undefined): void {
    this.#worktree = worktree ? structuredClone(worktree) : undefined;
    this.#cwd = worktree?.worktreePath ?? this.originalCwd;
  }

  exit(): void {
    this.#cwd = this.#worktree?.originalCwd ?? this.originalCwd;
    this.#worktree = undefined;
  }
}

export type WorkspaceRootSource = string | (() => string);

export function currentWorkspaceRoot(source: WorkspaceRootSource): string {
  return typeof source === "function" ? source() : source;
}
