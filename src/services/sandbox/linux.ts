import type { SandboxAvailability, SandboxConfig, SandboxRuntime } from "./types";
import {
  ensureSupportedNetwork,
  findExecutable,
  isStrictProfile,
  resolveSandboxPaths,
  STRICT_BWRAP_READONLY_ROOTS,
  type SandboxHost,
} from "./shared";

export function getLinuxSandboxAvailability(
  config: SandboxConfig,
  env: Record<string, string | undefined>,
  host: SandboxHost,
): SandboxAvailability {
  if (config.command === "sandbox-exec" || config.command === "powershell" || config.command === "appcontainer") {
    return {
      platform: host.platform,
      supported: false,
      requestedCommand: config.command,
      reason: `Sandbox backend '${config.command}' is unsupported on ${host.platform}; use bwrap or auto`,
      capabilities: {
        filesystem: "namespace",
        networkModes: ["open", "blocked"],
        process: "namespace",
      },
    };
  }
  const networkError = ensureSupportedNetwork(config.network, ["open", "blocked"]);
  if (networkError) {
    return {
      platform: host.platform,
      supported: false,
      requestedCommand: config.command,
      reason: networkError,
      capabilities: {
        filesystem: "namespace",
        networkModes: ["open", "blocked"],
        process: "namespace",
      },
    };
  }
  const executable = env.TNB_BWRAP_PATH ?? findExecutable(["bwrap"], env, host);
  if (!executable) {
    return {
      platform: host.platform,
      supported: false,
      requestedCommand: config.command,
      reason: "Sandbox requested, but bubblewrap (bwrap) is unavailable; install bubblewrap or set TNB_BWRAP_PATH",
      capabilities: {
        filesystem: "namespace",
        networkModes: ["open", "blocked"],
        process: "namespace",
      },
    };
  }
  return {
    platform: host.platform,
    supported: true,
    requestedCommand: config.command,
    resolvedCommand: "bwrap",
    executable,
    capabilities: {
      filesystem: "namespace",
      networkModes: ["open", "blocked"],
      process: "namespace",
    },
  };
}

export function createLinuxSandboxRuntime(options: {
  config: SandboxConfig;
  env: Record<string, string | undefined>;
  host: SandboxHost;
  availability: SandboxAvailability;
}): SandboxRuntime {
  const executable = options.availability.executable;
  if (!executable) {
    throw new Error("Sandbox requested, but bubblewrap (bwrap) is unavailable; install bubblewrap or set TNB_BWRAP_PATH");
  }
  return {
    enabled: true,
    command: "bwrap",
    networkAccess: options.config.network !== "blocked",
    profile: options.config.profile,
    network: options.config.network,
    allowedPaths: options.config.allowedPaths,
    availability: options.availability,
    wrap(file, args, cwd) {
      const paths = resolveSandboxPaths({
        cwd,
        configuredAllowedPaths: options.config.allowedPaths,
        env: options.env,
        host: options.host,
      });
      const bwrapArgs = buildBubblewrapArgs({
        executable: file,
        executableArgs: args,
        cwd,
        profile: options.config.profile,
        network: options.config.network,
        pathValue: options.env.PATH ?? options.host.pathValue ?? "",
        homeDirectory: options.host.homeDirectory,
        temporaryDirectory: options.host.temporaryDirectory,
        writableRoots: paths.writableRoots,
        readableRoots: paths.readableRoots,
        host: options.host,
      });
      return { file: executable, args: bwrapArgs };
    },
  };
}

function buildBubblewrapArgs(options: {
  executable: string;
  executableArgs: readonly string[];
  cwd: string;
  profile: SandboxConfig["profile"];
  network: SandboxConfig["network"];
  pathValue: string;
  homeDirectory: string;
  temporaryDirectory: string;
  writableRoots: readonly string[];
  readableRoots: readonly string[];
  host: SandboxHost;
}): string[] {
  const common = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...(options.network === "blocked" ? ["--unshare-net"] : []),
    "--clearenv",
    "--setenv",
    "PATH",
    options.pathValue,
    "--setenv",
    "HOME",
    options.homeDirectory,
    "--setenv",
    "TMPDIR",
    options.temporaryDirectory,
  ];
  const profileArgs = isStrictProfile(options.profile)
    ? buildStrictBubblewrapArgs(options)
    : buildHostBoundBubblewrapArgs(options);
  return [...common, ...profileArgs, "--chdir", options.cwd, "--", options.executable, ...options.executableArgs];
}

function buildHostBoundBubblewrapArgs(options: {
  writableRoots: readonly string[];
}): string[] {
  return [
    "--ro-bind",
    "/",
    "/",
    ...options.writableRoots.flatMap((path) => ["--bind", path, path]),
  ];
}

function buildStrictBubblewrapArgs(options: {
  writableRoots: readonly string[];
  readableRoots: readonly string[];
  host: SandboxHost;
}): string[] {
  const readOnlyRoots = new Set<string>([
    ...STRICT_BWRAP_READONLY_ROOTS.filter((path) => options.host.exists(path)),
    ...options.readableRoots.filter((path) => options.host.exists(path)),
  ]);
  for (const path of options.writableRoots) readOnlyRoots.delete(path);
  return [
    "--tmpfs",
    "/",
    ...[...readOnlyRoots].flatMap((path) => ["--ro-bind", path, path]),
    ...options.writableRoots.flatMap((path) => ["--bind", path, path]),
  ];
}
