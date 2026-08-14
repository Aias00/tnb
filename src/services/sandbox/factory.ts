import { createLinuxSandboxRuntime, getLinuxSandboxAvailability } from "./linux";
import { createMacSandboxRuntime, getMacSandboxAvailability } from "./macos-backend";
import { createSandboxHost, mergeSandboxConfig, type SandboxHost } from "./shared";
import type { SandboxAvailability, SandboxRuntime, SandboxSettings } from "./types";
import { createWindowsSandboxRuntime, getWindowsSandboxAvailability } from "./windows";

function getAvailabilityForConfig(options: {
  config: ReturnType<typeof mergeSandboxConfig>;
  env: Record<string, string | undefined>;
}, host: SandboxHost): SandboxAvailability {
  if (host.platform === "darwin") return getMacSandboxAvailability(options.config, host);
  if (host.platform === "linux") return getLinuxSandboxAvailability(options.config, options.env, host);
  if (host.platform === "win32") return getWindowsSandboxAvailability(options.config, options.env, host);
  return {
    platform: host.platform,
    supported: false,
    requestedCommand: options.config.command,
    reason: `Sandbox is unsupported on ${host.platform}`,
    capabilities: {
      filesystem: "best-effort",
      networkModes: [],
      process: "job-object",
    },
  };
}

export function getSandboxAvailability(
  options: {
    settings?: SandboxSettings | undefined;
    env: Record<string, string | undefined>;
  },
  host: SandboxHost = createSandboxHost(options.env),
): SandboxAvailability {
  const config = mergeSandboxConfig({ requested: false, settings: options.settings, env: options.env });
  return getAvailabilityForConfig({ config, env: options.env }, host);
}

export function createSandbox(options: {
  requested: boolean;
  settings?: SandboxSettings | undefined;
  env: Record<string, string | undefined>;
}, host: SandboxHost = createSandboxHost(options.env)): SandboxRuntime | undefined {
  const config = mergeSandboxConfig(options);
  if (!config.enabled) return undefined;
  const availability = getAvailabilityForConfig({ config, env: options.env }, host);
  if (!availability.supported || !availability.resolvedCommand) {
    throw new Error(availability.reason ?? `Sandbox requested, but no backend is available on ${host.platform}`);
  }
  if (host.platform === "darwin") {
    return createMacSandboxRuntime({ config, env: options.env, host, availability });
  }
  if (host.platform === "linux") {
    return createLinuxSandboxRuntime({ config, env: options.env, host, availability });
  }
  if (host.platform === "win32") {
    return createWindowsSandboxRuntime({ config, env: options.env, host, availability });
  }
  throw new Error(`Sandbox is unsupported on ${host.platform}`);
}

export function createSandboxRuntime(
  options: {
    requested: boolean;
    settings?: SandboxSettings | undefined;
    env: Record<string, string | undefined>;
  },
  host?: SandboxHost,
): SandboxRuntime | undefined {
  return createSandbox(options, host);
}
