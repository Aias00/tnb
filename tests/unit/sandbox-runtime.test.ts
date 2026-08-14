import { describe, expect, test } from "bun:test";

import {
  createSandbox,
  createSandboxHost,
  createSandboxRuntime,
  getSandboxAvailability,
} from "../../src/services/sandbox/macos";

function host(overrides: Partial<ReturnType<typeof createSandboxHost>>) {
  const base = createSandboxHost({ PATH: "/usr/bin:/bin" });
  return {
    ...base,
    platform: "darwin" as const,
    execPath: "/Applications/tnb/tnb",
    homeDirectory: "/Users/test",
    temporaryDirectory: "/tmp",
    exists: () => true,
    canExecute: () => true,
    canonicalize: (path: string) => path,
    ...overrides,
  };
}

describe("sandbox runtime factory", () => {
  test("returns undefined when sandbox is disabled", () => {
    expect(createSandboxRuntime({ requested: false, env: {} }, host({ platform: "darwin" }))).toBeUndefined();
  });

  test("uses sandbox-exec on macOS and preserves the legacy entrypoint", () => {
    const runtime = createSandboxRuntime(
      {
        requested: true,
        settings: { profile: "strict", networkAccess: false, allowedPaths: ["~/cache"] },
        env: { PATH: "/usr/bin:/bin" },
      },
      host({ platform: "darwin" }),
    );

    expect(runtime?.command).toBe("sandbox-exec");
    expect(runtime?.availability.resolvedCommand).toBe("sandbox-exec");
    const wrapped = runtime?.wrap("/bin/sh", ["-lc", "pwd"], "/workspace");
    expect(wrapped?.file).toBe("/usr/bin/sandbox-exec");
    expect(wrapped?.args[0]).toBe("-p");
    expect(wrapped?.args[1]).toContain('(deny network-outbound)');
    expect(wrapped?.args[1]).toContain('(deny file-read* file-write* (regex #"^/workspace');
  });

  test("auto-detects bubblewrap on Linux and injects namespace flags", () => {
    const runtime = createSandbox(
      {
        requested: true,
        settings: { profile: "strict", networkAccess: false, allowedPaths: ["/cache"] },
        env: { PATH: "/usr/bin:/bin" },
      },
      host({
        platform: "linux",
        canExecute: (path: string) => path === "/usr/bin/bwrap",
      }),
    );

    expect(runtime?.command).toBe("bwrap");
    const wrapped = runtime?.wrap("/bin/bash", ["-lc", "echo ok"], "/workspace");
    expect(wrapped?.file).toBe("/usr/bin/bwrap");
    expect(wrapped?.args).toContain("--tmpfs");
    expect(wrapped?.args).toContain("--unshare-net");
    expect(wrapped?.args).toContain("--clearenv");
    expect(wrapped?.args).toContain("/workspace");
  });

  test("fails closed when Linux is configured for unsupported proxied networking", () => {
    const availability = getSandboxAvailability(
      {
        settings: { enabled: true, network: "proxied" },
        env: { PATH: "/usr/bin:/bin" },
      },
      host({
        platform: "linux",
        canExecute: (path: string) => path === "/usr/bin/bwrap",
      }),
    );

    expect(availability.supported).toBe(false);
    expect(availability.reason).toContain("does not support network mode 'proxied'");
    expect(() =>
      createSandbox(
        {
          requested: true,
          settings: { enabled: true, network: "proxied" },
          env: { PATH: "/usr/bin:/bin" },
        },
        host({
          platform: "linux",
          canExecute: (path: string) => path === "/usr/bin/bwrap",
        }),
      ),
    ).toThrow("does not support network mode 'proxied'");
  });

  test("prefers PowerShell on Windows and wraps execution in an encoded job-object harness", () => {
    const runtime = createSandbox(
      {
        requested: true,
        settings: { enabled: true, profile: "restrictive", network: "open", allowedPaths: ["C:/cache"] },
        env: { PATH: "C:/Program Files/PowerShell/7;C:/Windows/System32" },
      },
      host({
        platform: "win32",
        canExecute: (path: string) => path === "C:/Program Files/PowerShell/7/pwsh.exe",
        exists: (path: string) => !path.startsWith("/"),
        canonicalize: (path: string) => path,
      }),
    );

    expect(runtime?.command).toBe("powershell");
    expect(runtime?.availability.capabilities.process).toBe("job-object");
    const wrapped = runtime?.wrap("C:/Windows/System32/cmd.exe", ["/c", "echo ok"], "C:/work");
    expect(wrapped?.file).toBe("C:/Program Files/PowerShell/7/pwsh.exe");
    expect(wrapped?.args).toEqual(expect.arrayContaining(["-EncodedCommand"]));
    expect(wrapped?.args.slice(-4)).toEqual([
      "--tnb-profile",
      "restrictive",
      "--tnb-allowed-paths",
      JSON.stringify(["C:/cache"]),
    ]);
  });

  test("fails closed when no backend is available", () => {
    expect(() =>
      createSandbox(
        {
          requested: true,
          settings: true,
          env: { PATH: "/usr/bin:/bin" },
        },
        host({
          platform: "linux",
          canExecute: () => false,
        }),
      ),
    ).toThrow("bubblewrap (bwrap) is unavailable");
  });
});
