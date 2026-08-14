import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serveRemoteControlSocket, type RemoteControlDescriptor } from "../../src/services/remote-control/server";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("remote-control socket server", () => {
  test("publishes a private descriptor, serves a local connection, and removes owned files", async () => {
    const root = await temporary();
    const socketPath = join(root, "ide", "tnb.sock");
    const descriptorPath = `${socketPath}.json`;
    const controller = new AbortController();
    let resolveReady!: (descriptor: RemoteControlDescriptor) => void;
    const ready = new Promise<RemoteControlDescriptor>((resolve) => { resolveReady = resolve; });
    const serving = serveRemoteControlSocket({
      socketPath,
      cwd: root,
      version: "1.2.3",
      signal: controller.signal,
      onReady: resolveReady,
      async handleConnection(socket) {
        for await (const chunk of socket) {
          socket.write(chunk);
          break;
        }
      },
    });

    const descriptor = await ready;
    expect(descriptor).toMatchObject({
      protocol: "tnb.stream-json/v1",
      socketPath,
      cwd: root,
      version: "1.2.3",
    });
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(descriptorPath)).mode & 0o777).toBe(0o600);

    const echoed = await new Promise<string>((resolve, reject) => {
      const client = createConnection(socketPath);
      client.setEncoding("utf8");
      client.once("connect", () => client.write("hello\n"));
      client.once("data", (text: string) => {
        resolve(text);
        client.end();
      });
      client.once("error", reject);
    });
    expect(echoed).toBe("hello\n");

    controller.abort();
    await serving;
    expect(await Bun.file(socketPath).exists()).toBe(false);
    expect(await Bun.file(descriptorPath).exists()).toBe(false);
  });

  test("does not replace a regular file at the requested socket path", async () => {
    const root = await temporary();
    const socketPath = join(root, "reserved");
    await writeFile(socketPath, "keep");
    await expect(serveRemoteControlSocket({
      socketPath,
      cwd: root,
      version: "1.0.0",
      signal: new AbortController().signal,
      async handleConnection() {},
    })).rejects.toThrow("exists and is not a socket");
    expect(await Bun.file(socketPath).text()).toBe("keep");
  });
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tnb-remote-control-"));
  directories.push(directory);
  return directory;
}
