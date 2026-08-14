import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import type { ToolOutput } from "../core/tool";
import type { ImageBlock } from "../core/message";

export const IMAGE_TARGET_RAW_SIZE = (5 * 1024 * 1024 * 3) / 4;
export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024;
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024;
export const PDF_MAX_PAGES_PER_READ = 20;
export const PDF_INLINE_PAGE_THRESHOLD = 10;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function isPdfPath(path: string): boolean {
  return extname(path).toLowerCase() === ".pdf";
}

export async function readImage(
  filePath: string,
  displayPath: string,
  signal: AbortSignal,
): Promise<ToolOutput> {
  const buffer = await readFile(filePath, { signal });
  if (buffer.length === 0) throw new Error(`Image file is empty: ${displayPath}`);
  if (buffer.length > IMAGE_TARGET_RAW_SIZE) {
    throw new Error(
      `Image exceeds the API-safe raw size of ${formatBytes(IMAGE_TARGET_RAW_SIZE)}. Resize or compress it before reading.`,
    );
  }
  const mediaType = detectImageType(buffer);
  if (!mediaType) {
    throw new Error(`File does not contain a supported PNG, JPEG, GIF, or WebP image: ${displayPath}`);
  }
  return {
    content: `Image file read: ${displayPath} (${formatBytes(buffer.length)})`,
    attachments: [imageBlock(buffer, mediaType)],
  };
}

export async function readPdf(
  filePath: string,
  displayPath: string,
  pages: string | undefined,
  signal: AbortSignal,
  capabilities: { supportsVision: boolean; supportsPdf: boolean },
): Promise<ToolOutput> {
  const fileStats = await stat(filePath);
  if (fileStats.size === 0) throw new Error(`PDF file is empty: ${displayPath}`);
  if (fileStats.size > PDF_MAX_EXTRACT_SIZE) {
    throw new Error(`PDF exceeds the maximum readable size of ${formatBytes(PDF_MAX_EXTRACT_SIZE)}`);
  }
  if (fileStats.size > PDF_TARGET_RAW_SIZE && pages === undefined) {
    throw new Error(
      `PDF exceeds the direct-read limit of ${formatBytes(PDF_TARGET_RAW_SIZE)}. Use pages to read a range of up to ${PDF_MAX_PAGES_PER_READ} pages.`,
    );
  }
  const header = await readFileHeader(filePath, 5, signal);
  if (header.toString("ascii") !== "%PDF-") {
    throw new Error(`File is not a valid PDF (missing %PDF- header): ${displayPath}`);
  }
  if (pages !== undefined) {
    if (!capabilities.supportsVision) {
      throw new Error("The selected model does not support the image content produced by PDF page extraction");
    }
    return extractPdfPages(filePath, displayPath, pages, signal);
  }

  const pageCount = await pdfPageCount(filePath, signal);
  if (pageCount !== undefined && pageCount > PDF_INLINE_PAGE_THRESHOLD) {
    throw new Error(
      `This PDF has ${pageCount} pages, which is too many to read at once. Use pages such as "1-5"; at most ${PDF_MAX_PAGES_PER_READ} pages may be read per call.`,
    );
  }
  if (!capabilities.supportsPdf) {
    if (!capabilities.supportsVision) {
      throw new Error("The selected model supports neither PDF documents nor image page extraction");
    }
    if (pageCount === undefined) {
      throw new Error(
        'The selected model does not accept PDF documents. Install Poppler and pass pages such as "1-5" to read the PDF as images.',
      );
    }
    return extractPdfPages(filePath, displayPath, `1-${pageCount}`, signal);
  }
  const buffer = await readFile(filePath, { signal });
  return {
    content: `PDF file read: ${displayPath} (${formatBytes(buffer.length)})`,
    attachments: [
      {
        type: "document",
        filename: basename(displayPath),
        source: {
          type: "base64",
          mediaType: "application/pdf",
          data: buffer.toString("base64"),
        },
      },
    ],
  };
}

async function extractPdfPages(
  filePath: string,
  displayPath: string,
  pages: string,
  signal: AbortSignal,
): Promise<ToolOutput> {
  const { start, end } = parsePageRange(pages);
  const directory = await mkdtemp(join(tmpdir(), "tnb-pdf-"));
  const prefix = join(directory, "page");
  try {
    await runProcess(
      "pdftoppm",
      ["-jpeg", "-r", "150", "-f", String(start), "-l", String(end), filePath, prefix],
      signal,
      "PDF page extraction requires Poppler's pdftoppm executable",
    );
    const names = (await readdir(directory))
      .filter((name) => name.toLowerCase().endsWith(".jpg"))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    if (names.length === 0) throw new Error(`No pages were extracted from ${displayPath}`);
    const attachments: ImageBlock[] = [];
    for (const name of names) {
      const buffer = await readFile(join(directory, name), { signal });
      if (buffer.length > IMAGE_TARGET_RAW_SIZE) {
        throw new Error(`Extracted PDF page ${name} exceeds the API-safe image size`);
      }
      attachments.push(imageBlock(buffer, "image/jpeg"));
    }
    return {
      content: `PDF pages ${start}-${end} read: ${displayPath} (${attachments.length} page image${attachments.length === 1 ? "" : "s"})`,
      attachments,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parsePageRange(value: string): { start: number; end: number } {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
  if (!match) throw new Error('pages must be a page number or inclusive range such as "1-5"');
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (start < 1 || end < start) throw new Error("pages must be a positive ascending range");
  if (end - start + 1 > PDF_MAX_PAGES_PER_READ) {
    throw new Error(`pages may include at most ${PDF_MAX_PAGES_PER_READ} pages per read`);
  }
  return { start, end };
}

async function pdfPageCount(filePath: string, signal: AbortSignal): Promise<number | undefined> {
  try {
    const output = await runProcess("pdfinfo", [filePath], signal);
    const match = /^Pages:\s+(\d+)/m.exec(output);
    return match ? Number(match[1]) : undefined;
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
}

function runProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
  missingMessage?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => void (stdout += chunk));
    child.stderr.on("data", (chunk: string) => void (stderr += chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" && missingMessage ? new Error(missingMessage) : error);
    });
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with code ${code ?? 1}`));
    });
  });
}

function imageBlock(buffer: Buffer, mediaType: ImageBlock["source"]["mediaType"]): ImageBlock {
  return {
    type: "image",
    source: { type: "base64", mediaType, data: buffer.toString("base64") },
  };
}

function detectImageType(buffer: Buffer): ImageBlock["source"]["mediaType"] | undefined {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  const six = buffer.subarray(0, 6).toString("ascii");
  if (six === "GIF87a" || six === "GIF89a") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

async function readFileHeader(filePath: string, bytes: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    signal.throwIfAborted();
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
