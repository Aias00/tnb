import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";

export async function resolveTypeScriptServerPath(): Promise<string> {
  const platformName = platform() === "win32" ? "win32" : platform();
  const architecture = arch() === "x64" ? "x64" : arch();
  const packageName = `typescript-${platformName}-${architecture}`;
  const executable = platform() === "win32" ? "tsc.exe" : "tsc";
  const candidates = [
    process.env.TNB_TSGO_PATH,
    join(dirname(process.execPath), platform() === "win32" ? "tnb-tsgo.exe" : "tnb-tsgo"),
    join(process.cwd(), "node_modules", "@typescript", packageName, "lib", executable),
    join(import.meta.dir, "..", "..", "..", "node_modules", "@typescript", packageName, "lib", executable),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    `TypeScript semantic analysis requires the TypeScript 7 native compiler. Install dependencies, place it beside tnb as tnb-tsgo, or set TNB_TSGO_PATH. Checked: ${candidates.join(", ")}`,
  );
}
