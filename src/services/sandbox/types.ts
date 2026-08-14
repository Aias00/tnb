export type SandboxCommandPreference = "auto" | "sandbox-exec" | "bwrap" | "powershell" | "appcontainer";

export type SandboxCommand = "sandbox-exec" | "bwrap" | "powershell";

export type SandboxProfile = "permissive" | "restrictive" | "strict";

export type SandboxNetworkMode = "open" | "proxied" | "blocked";

export type SandboxSettings =
  | boolean
  | {
      enabled?: boolean;
      command?: SandboxCommandPreference;
      allowedPaths?: string[];
      networkAccess?: boolean;
      profile?: SandboxProfile;
      network?: Exclude<SandboxNetworkMode, "blocked">;
    };

export type SandboxConfig = {
  enabled: boolean;
  command: SandboxCommandPreference;
  allowedPaths: string[];
  profile: SandboxProfile;
  network: SandboxNetworkMode;
};

export type SandboxAvailability = {
  readonly platform: NodeJS.Platform;
  readonly supported: boolean;
  readonly requestedCommand: SandboxCommandPreference;
  readonly resolvedCommand?: SandboxCommand;
  readonly executable?: string;
  readonly reason?: string;
  readonly capabilities: {
    readonly filesystem: "policy" | "namespace" | "best-effort";
    readonly networkModes: readonly SandboxNetworkMode[];
    readonly process: "sandbox" | "namespace" | "job-object";
  };
};

export type SandboxRuntime = {
  readonly enabled: true;
  readonly command: SandboxCommand;
  readonly networkAccess: boolean;
  readonly profile: SandboxProfile;
  readonly network: SandboxNetworkMode;
  readonly allowedPaths: readonly string[];
  readonly availability: SandboxAvailability;
  wrap(file: string, args: string[], cwd: string): { file: string; args: string[] };
};
