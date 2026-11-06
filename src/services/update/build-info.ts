import packageJson from "../../../package.json";

declare const TNB_BUILD_INFO: BuildInfo | undefined;
export type BuildInfo = { version: string; mode: "compiled" | "source"; commit: string | null; dirty: boolean | null; builtAt: string | null; sourceDigest: string | null; bun: string; platform: string; arch: string };

export function buildInfo(): BuildInfo {
  if (typeof TNB_BUILD_INFO !== "undefined") return { ...TNB_BUILD_INFO };
  return { version: packageJson.version, mode: "source", commit: null, dirty: null, builtAt: null, sourceDigest: null, bun: Bun.version, platform: process.platform, arch: process.arch };
}

export function sameBuild(left: BuildInfo, right: unknown): boolean | null {
  if (!right || typeof right !== "object" || !left.sourceDigest) return null;
  const other = right as Partial<BuildInfo>;
  if (!other.sourceDigest) return null;
  return left.version === other.version && left.sourceDigest === other.sourceDigest && left.bun === other.bun && left.platform === other.platform && left.arch === other.arch;
}
