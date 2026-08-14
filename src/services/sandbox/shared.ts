import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, delimiter, join, resolve } from "node:path";

import type {
  SandboxCommandPreference,
  SandboxConfig,
  SandboxNetworkMode,
  SandboxProfile,
  SandboxSettings,
} from "./types";

export type SandboxHost = {
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly homeDirectory: string;
  readonly temporaryDirectory: string;
  readonly pathValue: string | undefined;
  exists(path: string): boolean;
  canExecute(path: string): boolean;
  canonicalize(path: string): string;
};

export function createSandboxHost(env: Record<string, string | undefined>): SandboxHost {
  return {
    platform: platform(),
    execPath: process.execPath,
    homeDirectory: homedir(),
    temporaryDirectory: tmpdir(),
    pathValue: env.PATH,
    exists: existsSync,
    canExecute(path) {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    canonicalize(path) {
      const resolved = resolve(path);
      return existsSync(resolved) ? realpathSync(resolved) : resolved;
    },
  };
}

export function normalizeSandboxConfig(settings: SandboxSettings | undefined): SandboxConfig {
  if (settings === true) {
    return {
      enabled: true,
      command: "auto",
      allowedPaths: [],
      profile: "restrictive",
      network: "open",
    };
  }
  if (!settings) {
    return {
      enabled: false,
      command: "auto",
      allowedPaths: [],
      profile: "restrictive",
      network: "open",
    };
  }
  return {
    enabled: settings.enabled ?? true,
    command: settings.command ?? "auto",
    allowedPaths: settings.allowedPaths ?? [],
    profile: settings.profile ?? "restrictive",
    network: settings.network ?? (settings.networkAccess === false ? "blocked" : "open"),
  };
}

export function parseSandboxEnvironment(
  value: string | undefined,
): { enabled?: boolean; command?: SandboxCommandPreference } {
  if (value === undefined || value.trim() === "") return {};
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return { enabled: true };
  if (normalized === "auto") return { enabled: true, command: "auto" };
  if (normalized === "sandbox-exec") return { enabled: true, command: "sandbox-exec" };
  if (normalized === "bwrap") return { enabled: true, command: "bwrap" };
  if (normalized === "powershell" || normalized === "pwsh") return { enabled: true, command: "powershell" };
  if (normalized === "appcontainer") return { enabled: true, command: "appcontainer" };
  if (normalized === "0" || normalized === "false" || normalized === "off") return { enabled: false };
  throw new Error("TNB_SANDBOX must be true, false, auto, sandbox-exec, bwrap, powershell, or appcontainer");
}

export function mergeSandboxConfig(options: {
  requested: boolean;
  settings?: SandboxSettings | undefined;
  env: Record<string, string | undefined>;
}): SandboxConfig {
  const configured = normalizeSandboxConfig(options.settings);
  const environment = parseSandboxEnvironment(options.env.TNB_SANDBOX);
  if (environment.enabled === false) return { ...configured, enabled: false };
  return {
    ...configured,
    enabled: options.requested || environment.enabled === true || configured.enabled,
    command: environment.command ?? configured.command,
  };
}

export function expandPath(path: string, host: SandboxHost): string {
  if (path === "~") return host.homeDirectory;
  if (path.startsWith("~/")) return join(host.homeDirectory, path.slice(2));
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")) return path;
  return resolve(path);
}

export function defaultWritableRoots(cwd: string, allowedPaths: readonly string[], host: SandboxHost): string[] {
  return uniquePaths([
    cwd,
    host.temporaryDirectory,
    join(host.homeDirectory, ".npm"),
    join(host.homeDirectory, ".cache"),
    join(host.homeDirectory, ".bun"),
    ...allowedPaths,
  ], host);
}

export function defaultReadableRoots(
  cwd: string,
  writableRoots: readonly string[],
  env: Record<string, string | undefined>,
  host: SandboxHost,
): string[] {
  const roots = new Set<string>([cwd, host.canonicalize(dirname(dirname(host.execPath)))]);
  for (const entry of splitPathEntries(env.PATH)) {
    if (!entry.trim()) continue;
    const canonical = host.canonicalize(entry);
    roots.add(canonical.endsWith("/bin") ? dirname(canonical) : canonical);
  }
  for (const path of writableRoots) roots.add(host.canonicalize(path));
  return [...roots];
}

export function uniquePaths(paths: readonly string[], host: SandboxHost): string[] {
  return [...new Set(paths.map((path) => host.canonicalize(path)))];
}

export function findExecutable(
  names: readonly string[],
  env: Record<string, string | undefined>,
  host: SandboxHost,
): string | undefined {
  const directories = splitPathEntries(env.PATH ?? host.pathValue, host.platform);
  const candidates = host.platform === "win32"
    ? names.flatMap((name) => (name.includes(".") ? [name] : [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]))
    : [...names];
  for (const directory of directories) {
    for (const name of candidates) {
      const candidate = join(directory, name);
      if (host.canExecute(candidate)) return candidate;
    }
  }
  return undefined;
}

function splitPathEntries(pathValue: string | undefined, targetPlatform: NodeJS.Platform = platform()): string[] {
  if (!pathValue) return [];
  const separator = targetPlatform === "win32" ? ";" : delimiter;
  return pathValue.split(separator).filter(Boolean);
}

export function ensureSupportedNetwork(
  requested: SandboxNetworkMode,
  supported: readonly SandboxNetworkMode[],
): string | undefined {
  return supported.includes(requested)
    ? undefined
    : `Sandbox backend does not support network mode '${requested}'; supported modes: ${supported.join(", ")}`;
}

export function ensureSystemRootArgs(paths: readonly string[], host: SandboxHost): string[] {
  return paths.filter((path) => host.exists(path));
}

export function escapeProfilePath(path: string): string {
  return path.replace(/[\\"]/g, "\\$&");
}

export function escapeRegex(path: string): string {
  return escapeProfilePath(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const SYSTEM_READONLY_ROOTS = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/opt",
  "/etc",
  "/var",
  "/run",
] as const;

export const STRICT_BWRAP_READONLY_ROOTS = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/opt",
  "/etc",
  "/dev",
  "/var",
  "/run",
] as const;

export type ResolvedSandboxPaths = {
  readonly allowedPaths: string[];
  readonly writableRoots: string[];
  readonly readableRoots: string[];
};

export function resolveSandboxPaths(options: {
  cwd: string;
  configuredAllowedPaths: readonly string[];
  env: Record<string, string | undefined>;
  host: SandboxHost;
}): ResolvedSandboxPaths {
  const allowedPaths = options.configuredAllowedPaths.map((path) => expandPath(path, options.host));
  const writableRoots = defaultWritableRoots(options.cwd, allowedPaths, options.host);
  const readableRoots = defaultReadableRoots(options.cwd, writableRoots, options.env, options.host);
  return { allowedPaths, writableRoots, readableRoots };
}

export function isStrictProfile(profile: SandboxProfile): boolean {
  return profile === "strict";
}
