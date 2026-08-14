import { delimiter } from "node:path";

import type { SandboxAvailability, SandboxConfig, SandboxRuntime } from "./types";
import {
  escapeProfilePath,
  escapeRegex,
  resolveSandboxPaths,
  type SandboxHost,
} from "./shared";

export function getMacSandboxAvailability(
  config: SandboxConfig,
  host: SandboxHost,
): SandboxAvailability {
  if (config.command !== "auto" && config.command !== "sandbox-exec") {
    return {
      platform: host.platform,
      supported: false,
      requestedCommand: config.command,
      reason: `Sandbox backend '${config.command}' is unsupported on ${host.platform}; use sandbox-exec or auto`,
      capabilities: {
        filesystem: "policy",
        networkModes: ["open", "proxied", "blocked"],
        process: "sandbox",
      },
    };
  }
  const executable = "/usr/bin/sandbox-exec";
  if (!host.canExecute(executable)) {
    return {
      platform: host.platform,
      supported: false,
      requestedCommand: config.command,
      reason: "Sandbox requested, but /usr/bin/sandbox-exec is unavailable",
      capabilities: {
        filesystem: "policy",
        networkModes: ["open", "proxied", "blocked"],
        process: "sandbox",
      },
    };
  }
  return {
    platform: host.platform,
    supported: true,
    requestedCommand: config.command,
    resolvedCommand: "sandbox-exec",
    executable,
    capabilities: {
      filesystem: "policy",
      networkModes: ["open", "proxied", "blocked"],
      process: "sandbox",
    },
  };
}

export function createMacSandboxRuntime(options: {
  config: SandboxConfig;
  env: Record<string, string | undefined>;
  host: SandboxHost;
  availability: SandboxAvailability;
}): SandboxRuntime {
  const executable = options.availability.executable;
  if (!executable) throw new Error("Sandbox requested, but /usr/bin/sandbox-exec is unavailable");
  return {
    enabled: true,
    command: "sandbox-exec",
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
      const sandboxProfile = buildMacSandboxProfile({
        workspace: cwd,
        allowedPaths: paths.allowedPaths,
        writableRoots: paths.writableRoots,
        readableRoots: paths.readableRoots,
        profile: options.config.profile,
        network: options.config.network,
        env: options.env,
        host: options.host,
      });
      return {
        file: executable,
        args: ["-p", sandboxProfile, "--", file, ...args],
      };
    },
  };
}

function buildMacSandboxProfile(options: {
  workspace: string;
  allowedPaths: readonly string[];
  writableRoots: readonly string[];
  readableRoots: readonly string[];
  profile: SandboxConfig["profile"];
  network: SandboxConfig["network"];
  env: Record<string, string | undefined>;
  host: SandboxHost;
}): string {
  const workspace = options.host.canonicalize(options.workspace);
  const rules = [options.profile === "permissive" ? PERMISSIVE_PROFILE : BASE_PROFILE];
  if (options.profile === "restrictive") rules.push("(allow file-read*)");
  if (options.profile === "strict") {
    for (const path of options.readableRoots) {
      rules.push(`(allow file-read* (subpath "${escapeProfilePath(path)}"))`);
    }
  }
  for (const path of options.writableRoots) {
    rules.push(`(allow file-read* file-write* (subpath "${escapeProfilePath(path)}"))`);
  }
  const escapedWorkspace = escapeRegex(workspace);
  rules.push(`(deny file-read* file-write* (regex #"^${escapedWorkspace}/(.*/)?\\.env(\\..+)?$"))`);
  if (options.network === "open") rules.push(OPEN_NETWORK_PROFILE);
  if (options.network === "proxied") rules.push(PROXIED_NETWORK_PROFILE);
  if (options.network === "blocked") rules.push(BLOCKED_NETWORK_PROFILE);
  return `${rules.join("\n")}\n`;
}

const BASE_PROFILE = `(version 1)
(deny default)
(import "system.sb")

(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info*)

(allow file-map-executable
  (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks")
  (subpath "/usr/lib")
  (subpath "/bin")
  (subpath "/usr/bin"))

(allow file-write-data
  (require-all (path "/dev/null") (vnode-type CHARACTER-DEVICE)))

(allow sysctl-read)
(allow mach-lookup
  (global-name "com.apple.sysmond")
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.logd")
  (global-name "com.apple.secinitd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.trustd"))
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow ipc-posix-sem)
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
  (require-all
    (regex #"^/dev/ttys[0-9]+")
    (extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))

(allow file-read*
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/usr/bin")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/usr/local/bin")
  (subpath "/opt/homebrew")
  (subpath "/Library")
  (subpath "/private/var/run")
  (subpath "/private/var/db")
  (subpath "/private/etc"))

(allow file-read* file-write*
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/tty")
  (subpath "/dev/fd")
  (subpath "/tmp")
  (subpath "/private/tmp"))

(allow file-read-metadata
  (literal "/")
  (subpath "/var")
  (subpath "/private/var")
  (subpath "/dev"))`;

const PERMISSIVE_PROFILE = `(version 1)
(allow default)
(deny file-write*)`;

const OPEN_NETWORK_PROFILE = `(allow network-outbound)
(allow network-inbound (local ip "localhost:9229"))
(allow network-bind)
(allow system-socket
  (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))
(allow mach-lookup
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.networkd")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.mDNSResponder")
  (global-name "com.apple.mDNSResponderHelper")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd"))`;

const PROXIED_NETWORK_PROFILE = `(deny network-inbound)
(deny network-outbound)
(allow network-inbound (local ip "localhost:9229"))
(allow network-outbound (remote tcp "localhost:8877"))
(allow network-bind (local ip "*:*"))`;

const BLOCKED_NETWORK_PROFILE = `(deny network-inbound)
(deny network-outbound)
(deny network-bind)`;
