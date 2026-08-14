import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { JsonRpcMessage, McpTransport } from "./client";
import type { McpStdioServerConfig } from "./config";

export type StdioMcpTransportOptions = McpStdioServerConfig & {
  cwd: string;
  onStderr?(text: string): void;
};

export class StdioMcpTransport implements McpTransport {
  readonly supportsModernProtocolProbe = true;
  private child?: ChildProcessWithoutNullStreams;
  private closing = false;
  private receive?: (message: JsonRpcMessage) => void;
  private onError: ((error: Error) => void) | undefined;

  constructor(private readonly options: StdioMcpTransportOptions) {}

  async start(
    receive: (message: JsonRpcMessage) => void,
    onError?: (error: Error) => void,
  ): Promise<void> {
    if (this.child) throw new Error("MCP stdio transport already started");
    this.receive = receive;
    this.onError = onError;
    this.spawnChild();
  }

  async prepareLegacyFallback(): Promise<void> {
    const child = this.child;
    if (child) {
      this.closing = true;
      child.stdin.end();
      if (!(await waitForExit(child, 250))) child.kill("SIGTERM");
      await waitForExit(child, 1_000);
    }
    delete this.child;
    this.closing = false;
    this.spawnChild();
  }

  private spawnChild(): void {
    const receive = this.receive;
    if (!receive) throw new Error("MCP stdio transport is not started");
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            receive(parseMessage(line));
          } catch (error) {
            this.onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: string) => this.options.onStderr?.(chunk));
    child.on("error", (error) => this.onError?.(error));
    child.on("exit", (code, signal) => {
      if (!this.closing) {
        this.onError?.(
          new Error(
            `MCP server exited before shutdown (${code === null ? signal : `code ${code}`})`,
          ),
        );
      }
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error("MCP stdio transport is not writable");
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.closing = true;
    child.stdin.end();
    if (await waitForExit(child, 1_000)) return;
    child.kill("SIGTERM");
    if (await waitForExit(child, 1_000)) return;
    child.kill("SIGKILL");
    await waitForExit(child, 1_000);
  }
}

function parseMessage(line: string): JsonRpcMessage {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("MCP stdio server emitted a non-object JSON-RPC message");
  }
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") throw new Error("MCP stdio server emitted invalid JSON-RPC");
  return value as JsonRpcMessage;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", exited);
      resolve(false);
    }, timeoutMs);
    const exited = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", exited);
  });
}
