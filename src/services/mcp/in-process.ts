import type { JsonRpcMessage, McpTransport } from "./client";

class InProcessMcpTransport implements McpTransport {
  private peer?: InProcessMcpTransport;
  private receive?: (message: JsonRpcMessage) => void;
  private onError: ((error: Error) => void) | undefined;
  private closed = false;

  link(peer: InProcessMcpTransport): void {
    this.peer = peer;
  }

  async start(
    receive: (message: JsonRpcMessage) => void,
    onError?: (error: Error) => void,
  ): Promise<void> {
    if (this.closed) throw new Error("MCP in-process transport is closed");
    this.receive = receive;
    this.onError = onError;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("MCP in-process transport is closed");
    const peer = this.peer;
    if (!peer || peer.closed) throw new Error("MCP in-process peer is closed");
    queueMicrotask(() => {
      try {
        peer.receive?.(structuredClone(message));
      } catch (error) {
        peer.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.peer && !this.peer.closed) this.peer.closed = true;
  }
}

export function createLinkedMcpTransportPair(): [McpTransport, McpTransport] {
  const client = new InProcessMcpTransport();
  const server = new InProcessMcpTransport();
  client.link(server);
  server.link(client);
  return [client, server];
}
