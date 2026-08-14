import { Buffer } from "node:buffer";

import type { SandboxAvailability, SandboxConfig, SandboxRuntime } from "./types";
import {
  ensureSupportedNetwork,
  findExecutable,
  resolveSandboxPaths,
  type SandboxHost,
} from "./shared";

export function getWindowsSandboxAvailability(
  config: SandboxConfig,
  env: Record<string, string | undefined>,
  host: SandboxHost,
): SandboxAvailability {
  if (config.command === "sandbox-exec" || config.command === "bwrap") {
    return {
      platform: host.platform,
      supported: false,
      requestedCommand: config.command,
      reason: `Sandbox backend '${config.command}' is unsupported on ${host.platform}; use powershell or auto`,
      capabilities: {
        filesystem: "best-effort",
        networkModes: ["open"],
        process: "job-object",
      },
    };
  }
  const networkError = ensureSupportedNetwork(config.network, ["open"]);
  if (networkError) {
    return {
      platform: host.platform,
      supported: false,
      requestedCommand: config.command,
      reason: networkError,
      capabilities: {
        filesystem: "best-effort",
        networkModes: ["open"],
        process: "job-object",
      },
    };
  }
  const executable = env.TNB_POWERSHELL_PATH
    ?? findExecutable(["pwsh", "powershell"], env, host);
  if (!executable) {
    return {
      platform: host.platform,
      supported: false,
      requestedCommand: config.command,
      reason: "Sandbox requested, but neither pwsh nor powershell.exe is available; install PowerShell 7 or set TNB_POWERSHELL_PATH",
      capabilities: {
        filesystem: "best-effort",
        networkModes: ["open"],
        process: "job-object",
      },
    };
  }
  return {
    platform: host.platform,
    supported: true,
    requestedCommand: config.command,
    resolvedCommand: "powershell",
    executable,
    capabilities: {
      filesystem: "best-effort",
      networkModes: ["open"],
      process: "job-object",
    },
  };
}

export function createWindowsSandboxRuntime(options: {
  config: SandboxConfig;
  env: Record<string, string | undefined>;
  host: SandboxHost;
  availability: SandboxAvailability;
}): SandboxRuntime {
  const executable = options.availability.executable;
  if (!executable) {
    throw new Error("Sandbox requested, but neither pwsh nor powershell.exe is available; install PowerShell 7 or set TNB_POWERSHELL_PATH");
  }
  return {
    enabled: true,
    command: "powershell",
    networkAccess: true,
    profile: options.config.profile,
    network: "open",
    allowedPaths: options.config.allowedPaths,
    availability: options.availability,
    wrap(file, args, cwd) {
      const paths = resolveSandboxPaths({
        cwd,
        configuredAllowedPaths: options.config.allowedPaths,
        env: options.env,
        host: options.host,
      });
      const encodedCommand = encodePowerShellCommand(buildPowerShellSandboxScript());
      return {
        file: executable,
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encodedCommand,
          cwd,
          file,
          ...args,
          "--tnb-profile",
          options.config.profile,
          "--tnb-allowed-paths",
          JSON.stringify(paths.allowedPaths),
        ],
      };
    },
  };
}

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function buildPowerShellSandboxScript(): string {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class TnbSandboxJob
{
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        int infoType,
        IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    public static IntPtr AttachCurrentProcess()
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(limits));
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)Marshal.SizeOf(limits)))
            {
                return IntPtr.Zero;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }

        return AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle) ? job : IntPtr.Zero;
    }
}
"@

$job = [IntPtr]::Zero
try { $job = [TnbSandboxJob]::AttachCurrentProcess() } catch {}
$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'

$argumentCount = $args.Length
if ($argumentCount -lt 2) { throw 'sandbox wrapper requires cwd and executable' }

$metadataIndex = $argumentCount
for ($index = 2; $index -lt $argumentCount; $index++) {
  if ($args[$index] -eq '--tnb-profile') {
    $metadataIndex = $index
    break
  }
}

$cwd = $args[0]
$exe = $args[1]
$exeArgs = @()
if ($metadataIndex -gt 2) {
  $exeArgs = $args[2..($metadataIndex - 1)]
}
if ($metadataIndex -lt $argumentCount) {
  $env:TNB_SANDBOX_PROFILE = $args[$metadataIndex + 1]
}
if ($metadataIndex + 3 -lt $argumentCount) {
  $env:TNB_SANDBOX_ALLOWED_PATHS = $args[$metadataIndex + 3]
}

Set-Location -LiteralPath $cwd
& $exe @exeArgs
exit $LASTEXITCODE
`.trim();
}
