import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSandboxRuntime, getSandboxAvailability } from "../../src/services/sandbox/factory";
import { probeSandboxRuntime } from "../../src/services/sandbox/probe";
import type { SandboxRuntime } from "../../src/services/sandbox/types";

// A missing optional backend skips locally; dedicated platform CI requires it.
const available = getSandboxAvailability({ env: process.env });
const required = process.env.TNB_REQUIRE_NATIVE_SANDBOX === "1";
test("native sandbox backend is present when required by CI", () => {
  if (required) expect(available.supported).toBe(true);
});

describe.skipIf(!available.supported)(`native sandbox effects (${process.platform})`, () => {
  let root: string;
  let cwd: string;
  beforeAll(async () => {
    // Outside OS temp/cache roots, which are intentionally writable.
    root = await mkdtemp(join(homedir(), ".tnb-native-sandbox-"));
    cwd = join(root, "workspace");
    await mkdir(cwd);
    await writeFile(join(cwd, ".env"), "synthetic-secret");
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  const runtime = (blocked = false, strict = false) => createSandboxRuntime({
    requested: true, env: process.env,
    settings: { profile: strict ? "strict" : "restrictive", networkAccess: !blocked },
  })!;
  const run = (sandbox: SandboxRuntime, file: string, args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const wrapped = sandbox.wrap(file, args, cwd);
    execFile(wrapped.file, wrapped.args, { cwd, env: process.env, timeout: 8_000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });

  test("backend can actually launch under its selected policy", async () => {
    await probeSandboxRuntime(runtime(), cwd, process.env);
  }, process.platform === "win32" ? 35_000 : 20_000);

  test.skipIf(process.platform !== "linux")("Linux descendants inherit no effective capabilities", async () => {
    const result = await run(runtime(), "/bin/cat", ["/proc/self/status"]);
    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(result.stdout.match(/^CapEff:\s+([0-9a-f]+)$/m)?.[1]).toMatch(/^0+$/);
  });

  for (const strict of [false, true]) {
    test.skipIf(process.platform === "win32")(`${strict ? "strict" : "restrictive"}: workspace writes succeed, descendant writes outside grants fail`, async () => {
      const sandbox = runtime(false, strict);
      const allowed = join(cwd, `allowed-${strict}`);
      const denied = join(root, `denied-${strict}`);
      const positive = await run(sandbox, "/bin/sh", ["-c", 'printf allowed > "$1"', "probe", allowed]);
      expect(positive, positive.stderr).toMatchObject({ code: 0 });
      expect(await readFile(allowed, "utf8")).toBe("allowed");
      const negative = await run(sandbox, "/bin/sh", ["-c", '/bin/sh -c \'printf forbidden > "$1"\' child "$1"', "probe", denied]);
      expect(negative.code).not.toBe(0);
      expect(await Bun.file(denied).exists()).toBe(false);
    });
  }

  test.skipIf(process.platform === "win32")("sensitive-file policy matches the advertised platform boundary", async () => {
    const result = await run(runtime(), "/bin/cat", [join(cwd, ".env")]);
    if (process.platform === "darwin") { expect(result.code).not.toBe(0); expect(result.stdout).toBe(""); }
    else { expect(result.code).toBe(0); expect(result.stdout).toBe("synthetic-secret"); }
  });

  test.skipIf(process.platform === "win32")("blocked network prevents a connection that succeeds in open mode", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("sandbox-network-probe") });
    try {
      const args = ["--noproxy", "*", "--silent", "--show-error", "--max-time", "2", `http://127.0.0.1:${server.port}/`];
      const open = await run(runtime(), "/usr/bin/curl", args);
      expect(open, open.stderr).toMatchObject({ code: 0, stdout: "sandbox-network-probe" });
      const blocked = await run(runtime(true), "/usr/bin/curl", args);
      expect(blocked.code).not.toBe(0);
      expect(blocked.stdout).not.toContain("sandbox-network-probe");
    } finally { server.stop(true); }
  });

  test.skipIf(process.platform !== "win32")("Windows reports best-effort access and rejects unsupported guarantees", async () => {
    const sandbox = runtime();
    expect(sandbox.availability.capabilities.filesystem).toBe("best-effort");
    // This intentionally proves the boundary: native children can write outside grants.
    const path = join(root, "windows-outside");
    const result = await run(sandbox, process.execPath, ["-e", 'require("node:fs").writeFileSync(process.argv[1], "best-effort")', path, "--tnb-profile", "literal-argument"]);
    expect(result, result.stderr).toMatchObject({ code: 0 });
    expect(await readFile(path, "utf8")).toBe("best-effort");
    expect(() => runtime(true)).toThrow("network mode");
    expect(() => runtime(false, true)).toThrow("strict filesystem");
    expect(() => createSandboxRuntime({ requested: true, env: process.env, settings: { command: "appcontainer" } })).toThrow("AppContainer");
  });
});
