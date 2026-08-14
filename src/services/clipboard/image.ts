import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export async function saveClipboardImage(cwd: string): Promise<string | undefined> {
  const directory = resolve(cwd, ".tnb", "pasted-images");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${randomUUID()}.png`);
  try {
    const saved = process.platform === "darwin"
      ? await saveMacImage(path)
      : process.platform === "linux"
        ? await saveLinuxImage(path)
        : process.platform === "win32"
          ? await saveWindowsImage(path)
          : false;
    if (!saved || !isPng(await readFile(path).catch(() => Buffer.alloc(0)))) return undefined;
    return relative(cwd, path);
  } finally {
    const bytes = await readFile(path).catch(() => undefined);
    if (bytes && !isPng(bytes)) await unlink(path).catch(() => undefined);
  }
}

async function saveMacImage(path: string): Promise<boolean> {
  const escaped = path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return run([
    "osascript",
    "-e", "set png_data to (the clipboard as «class PNGf»)",
    "-e", `set fp to open for access POSIX file "${escaped}" with write permission`,
    "-e", "set eof fp to 0",
    "-e", "write png_data to fp",
    "-e", "close access fp",
  ]);
}

async function saveLinuxImage(path: string): Promise<boolean> {
  for (const command of [
    ["wl-paste", "--no-newline", "--type", "image/png"],
    ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
  ]) {
    const bytes = await output(command);
    if (bytes && isPng(bytes)) {
      await writeFile(path, bytes);
      return true;
    }
  }
  return false;
}

async function saveWindowsImage(path: string): Promise<boolean> {
  const escaped = path.replaceAll("'", "''");
  return run([
    "powershell",
    "-NoProfile",
    "-Command",
    `Add-Type -AssemblyName System.Windows.Forms; $image=[Windows.Forms.Clipboard]::GetImage(); if ($null -eq $image) { exit 1 }; $image.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  ]);
}

async function run(command: string[]): Promise<boolean> {
  try {
    const process = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    return await process.exited === 0;
  } catch {
    return false;
  }
}

async function output(command: string[]): Promise<Buffer | undefined> {
  try {
    const process = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
    const bytes = Buffer.from(await new Response(process.stdout).arrayBuffer());
    return await process.exited === 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}
