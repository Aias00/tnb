import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { IdeJsonRpcClient } from "./ide-client";

type Writer = { write(text: string): unknown };

export type IdeCommandOptions = {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  stdout: Writer;
  stderr: Writer;
  configDir?: string;
  signal?: AbortSignal;
};

export type IdeDescriptorSummary = {
  path: string;
  socketPath?: string;
  pid?: number;
  workspace?: string;
  version?: string;
  startedAt?: string;
  active: boolean;
};

const IDE_HELP = `Usage: tnb ide [list|status|context|query <prompt>] [options]

Connect to a local tnb IDE JSON-RPC bridge.

Commands:
  list                          List discovery descriptors (default)
  status                        Show bridge capabilities and editor state
  context                       Show the current editor context
  query <prompt>                Run an agent query with editor context

Options:
  --descriptor <path>           Use a specific 0600 discovery descriptor
  --session <id>                Continue a session for ide query
  --json                        Print machine-readable JSON
  -h, --help                    Show help
`;

export async function runIdeCommand(options: IdeCommandOptions): Promise<number> {
  try {
    const action = options.argv[1] && !options.argv[1]!.startsWith("-") ? options.argv[1]! : "list";
    if (action === "help" || options.argv.includes("--help") || options.argv.includes("-h")) {
      options.stdout.write(IDE_HELP);
      return 0;
    }
    if (action === "list") {
      const descriptors = await discoverIdeDescriptors(join(resolveConfigDir(options), "ide"));
      if (options.argv.includes("--json")) {
        options.stdout.write(`${JSON.stringify(descriptors, null, 2)}\n`);
      } else if (!descriptors.length) {
        options.stdout.write("No IDE bridges found. Start one with tnb remote-control --socket ~/.tnb/ide/editor.sock\n");
      } else {
        for (const descriptor of descriptors) {
          options.stdout.write(`${descriptor.active ? "active" : "stale"}\t${descriptor.pid ?? "?"}\t${descriptor.workspace ?? "?"}\t${descriptor.path}\n`);
        }
      }
      return 0;
    }
    if (action !== "status" && action !== "context" && action !== "query") {
      throw new Error(`Unknown ide command: ${action}`);
    }

    const descriptorPath = await selectDescriptor(options);
    const client = await IdeJsonRpcClient.connect({ descriptorPath, signal: options.signal });
    try {
      if (action === "context") {
        writeValue(options.stdout, await client.getContext(), options.argv.includes("--json"));
      } else if (action === "status") {
        const status = await client.status();
        writeValue(options.stdout, {
          descriptor: descriptorPath,
          protocolVersion: client.server.protocolVersion,
          capabilities: client.server.capabilities,
          ...status,
        }, options.argv.includes("--json"));
      } else {
        const prompt = positionalAfterAction(options.argv, action).join(" ").trim();
        if (!prompt) throw new Error("ide query requires a prompt");
        writeValue(options.stdout, await client.query(prompt, optionValue(options.argv, "--session")), true);
      }
      return 0;
    } finally {
      client.close();
    }
  } catch (error) {
    options.stderr.write(`tnb: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function discoverIdeDescriptors(directory: string): Promise<IdeDescriptorSummary[]> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const descriptors: IdeDescriptorSummary[] = [];
  for (const name of names.sort()) {
    const path = join(directory, name);
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (record.protocol !== "tnb.stream-json/v1") continue;
      const protocols = Array.isArray(record.protocols) ? record.protocols : [];
      if (!protocols.includes("tnb.ide-jsonrpc/v1")) continue;
      const socketPath = typeof record.socketPath === "string" ? record.socketPath : undefined;
      const pid = typeof record.pid === "number" && Number.isSafeInteger(record.pid) ? record.pid : undefined;
      descriptors.push({
        path,
        ...(socketPath ? { socketPath } : {}),
        ...(pid ? { pid } : {}),
        ...(typeof record.cwd === "string" ? { workspace: record.cwd } : {}),
        ...(typeof record.version === "string" ? { version: record.version } : {}),
        ...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
        active: Boolean(socketPath && pid && await socketExists(socketPath) && processExists(pid)),
      });
    } catch {
      // Discovery descriptors are runtime-owned indexes. Invalid or concurrently
      // removed entries cannot be connected to, so listing excludes them.
    }
  }
  return descriptors;
}

async function selectDescriptor(options: IdeCommandOptions): Promise<string> {
  const explicit = optionValue(options.argv, "--descriptor");
  if (explicit) return resolve(options.cwd, explicit);
  const active = (await discoverIdeDescriptors(join(resolveConfigDir(options), "ide"))).filter((item) => item.active);
  const workspaceMatches = active.filter((item) => item.workspace && resolve(item.workspace) === resolve(options.cwd));
  if (workspaceMatches.length === 1) return workspaceMatches[0]!.path;
  if (workspaceMatches.length > 1) throw new Error("Multiple active IDE bridges match this workspace; use --descriptor <path>");
  if (active.length === 1) return active[0]!.path;
  if (!active.length) throw new Error("No active IDE bridge found; start one with tnb remote-control --socket ~/.tnb/ide/editor.sock");
  throw new Error("Multiple active IDE bridges found; use --descriptor <path>");
}

function positionalAfterAction(argv: string[], action: string): string[] {
  const start = argv.indexOf(action) + 1;
  const values: string[] = [];
  for (let index = start; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--descriptor" || value === "--session") {
      index += 1;
      continue;
    }
    if (value === "--json") continue;
    if (value.startsWith("-")) throw new Error(`Unknown ide option: ${value}`);
    values.push(value);
  }
  return values;
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function writeValue(writer: Writer, value: unknown, json: boolean): void {
  if (!json && typeof value === "string") writer.write(`${value}\n`);
  else writer.write(`${JSON.stringify(value, null, 2)}\n`);
}

function resolveConfigDir(options: IdeCommandOptions): string {
  return options.configDir ?? options.env.TNB_HOME ?? join(homedir(), ".tnb");
}

async function socketExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isSocket() === true;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
