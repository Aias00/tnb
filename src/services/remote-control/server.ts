import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";

export type RemoteControlDescriptor = {
  protocol: "tnb.stream-json/v1";
  protocols: ["tnb.stream-json/v1", "tnb.ide-jsonrpc/v1"];
  socketPath: string;
  pid: number;
  cwd: string;
  version: string;
  startedAt: string;
  ownerToken: string;
};

export async function serveRemoteControlSocket(options: {
  socketPath: string;
  descriptorPath?: string;
  cwd: string;
  version: string;
  signal: AbortSignal;
  handleConnection(socket: Socket, descriptor: RemoteControlDescriptor): Promise<void>;
  onReady?(descriptor: RemoteControlDescriptor): void;
}): Promise<void> {
  const socketPath = resolve(options.socketPath);
  const descriptorPath = resolve(options.descriptorPath ?? `${socketPath}.json`);
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await prepareSocketPath(socketPath);
  const ownerToken = randomUUID();
  const descriptor: RemoteControlDescriptor = {
    protocol: "tnb.stream-json/v1",
    protocols: ["tnb.stream-json/v1", "tnb.ide-jsonrpc/v1"],
    socketPath,
    pid: process.pid,
    cwd: options.cwd,
    version: options.version,
    startedAt: new Date().toISOString(),
    ownerToken,
  };
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void options.handleConnection(socket, descriptor).catch((error) => {
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify({
          type: "result",
          subtype: "error",
          error: error instanceof Error ? error.message : String(error),
        })}\n`);
      }
    }).finally(() => socket.end());
  });
  const abort = () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) server.close();
  };
  let socketIdentity: { dev: number; ino: number } | undefined;
  let descriptorWritten = false;
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    await listen(server, socketPath);
    const identity = await stat(socketPath);
    socketIdentity = { dev: identity.dev, ino: identity.ino };
    await chmod(socketPath, 0o600);
    await writeDescriptor(descriptorPath, descriptor);
    descriptorWritten = true;
    options.onReady?.(descriptor);
    if (options.signal.aborted) abort();
    await closed(server);
  } finally {
    options.signal.removeEventListener("abort", abort);
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    if (socketIdentity) await removeOwnedSocket(socketPath, socketIdentity.dev, socketIdentity.ino);
    if (descriptorWritten) await removeOwnedDescriptor(descriptorPath, ownerToken);
  }
}

async function prepareSocketPath(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!info.isSocket()) throw new Error(`Remote-control path exists and is not a socket: ${path}`);
  if (await socketAcceptsConnections(path)) {
    throw new Error(`Remote-control socket is already active: ${path}`);
  }
  await unlink(path);
}

async function socketAcceptsConnections(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolveProbe, reject) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(value);
    };
    const timer = setTimeout(() => finish(false), 250);
    timer.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish(false);
      else {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

async function closed(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.once("close", resolveClose);
    server.once("error", reject);
  });
}

async function writeDescriptor(path: string, descriptor: RemoteControlDescriptor): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function removeOwnedSocket(path: string, device: number, inode: number): Promise<void> {
  const info = await lstat(path).catch((error) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (info?.isSocket() && info.dev === device && info.ino === inode) await unlink(path);
}

async function removeOwnedDescriptor(path: string, ownerToken: string): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissing(error)) return;
    return;
  }
  if (
    typeof value === "object" && value !== null && !Array.isArray(value) &&
    (value as { ownerToken?: unknown }).ownerToken === ownerToken
  ) await unlink(path);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
