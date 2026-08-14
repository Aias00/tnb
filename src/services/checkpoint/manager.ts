import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { gitRoot, runGit } from "../git/command";

export type CheckpointRecord = {
  version: 1;
  id: string;
  label: string;
  createdAt: string;
  root: string;
  head: string;
  snapshotCommit: string;
  indexTree: string;
  automatic?: boolean;
  sessionId?: string;
  sessionCwd?: string;
  messageCount?: number;
};

export class CheckpointManager {
  constructor(private readonly configDir: string) {}

  async create(
    cwd: string,
    label = "Manual checkpoint",
    metadata: {
      automatic?: boolean;
      sessionId?: string;
      sessionCwd?: string;
      messageCount?: number;
    } = {},
  ): Promise<CheckpointRecord> {
    const root = await gitRoot(cwd);
    const head = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    const indexTree = (await runGit(root, ["write-tree"])).stdout.trim();
    const gitIndexValue = (await runGit(root, ["rev-parse", "--git-path", "index"])).stdout.trim();
    const gitIndex = isAbsolute(gitIndexValue) ? gitIndexValue : resolve(root, gitIndexValue);
    const temporary = await mkdtemp(join(tmpdir(), "tnb-checkpoint-"));
    const temporaryIndex = join(temporary, "index");
    try {
      await copyFile(gitIndex, temporaryIndex);
      const env = { GIT_INDEX_FILE: temporaryIndex };
      await runGit(root, ["add", "-A"], { env });
      const tree = (await runGit(root, ["write-tree"], { env })).stdout.trim();
      const snapshotCommit = (await runGit(root, ["commit-tree", tree, "-p", head, "-m", `tnb checkpoint: ${label}`])).stdout.trim();
      const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      await runGit(root, ["update-ref", `refs/tnb/checkpoints/${id}`, snapshotCommit]);
      const record: CheckpointRecord = {
        version: 1,
        id,
        label,
        createdAt: new Date().toISOString(),
        root,
        head,
        snapshotCommit,
        indexTree,
        ...metadata,
      };
      const directory = this.directory(root);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
      return record;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async createTurnCheckpoint(options: {
    cwd: string;
    sessionId: string;
    sessionCwd: string;
    messageCount: number;
  }): Promise<CheckpointRecord | undefined> {
    const head = await runGit(options.cwd, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
    if (head.exitCode !== 0) return undefined;
    return this.create(options.cwd, `Before session turn ${options.messageCount + 1}`, {
      automatic: true,
      sessionId: options.sessionId,
      sessionCwd: options.sessionCwd,
      messageCount: options.messageCount,
    });
  }

  async list(cwd: string): Promise<CheckpointRecord[]> {
    const root = await gitRoot(cwd);
    let names: string[];
    try {
      names = await readdir(this.directory(root));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      const value = JSON.parse(await readFile(join(this.directory(root), name), "utf8")) as CheckpointRecord;
      if (value.version !== 1 || value.root !== root || value.id !== basename(name, ".json")) {
        throw new Error(`Invalid checkpoint metadata: ${name}`);
      }
      return value;
    }));
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async rollback(cwd: string, id: string, force = false): Promise<CheckpointRecord> {
    const root = await gitRoot(cwd);
    const record = await this.get(root, id);
    const head = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    if (head !== record.head && !force) {
      throw new Error("HEAD changed after this checkpoint; pass force=true only after confirming the newer commits may be overwritten in the working tree");
    }
    await runGit(root, ["clean", "-fd"]);
    await runGit(root, ["read-tree", "--reset", "-u", record.snapshotCommit]);
    await runGit(root, ["read-tree", record.indexTree]);
    return record;
  }

  private async get(root: string, id: string): Promise<CheckpointRecord> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid checkpoint id: ${id}`);
    const record = JSON.parse(await readFile(join(this.directory(root), `${id}.json`), "utf8")) as CheckpointRecord;
    if (record.version !== 1 || record.id !== id || record.root !== root) throw new Error(`Invalid checkpoint: ${id}`);
    return record;
  }

  private directory(root: string): string {
    return join(this.configDir, "checkpoints", Buffer.from(root).toString("base64url"));
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
