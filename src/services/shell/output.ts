import { open } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { WriteStream } from "node:fs";

export const MAX_COMMAND_LOG_BYTES = 8 * 1024 * 1024;
export const MAX_RUNTIME_LOG_BYTES = 64 * 1024 * 1024;

/** Retain a capped prefix on disk. Pipes still drain after the quota is reached. */
export class ShellOutputLog {
  #written = 0;
  #truncated = false;
  #error: string | undefined;
  readonly #paused = new Set<Readable>();
  readonly #closed: Promise<void>;
  #finishing: Promise<void> | undefined;

  private constructor(readonly path: string, readonly writer: WriteStream,
    readonly reserve: (bytes: number) => number) {
    this.#closed = new Promise((resolve) => writer.once("close", () => { this.#resume(); resolve(); }));
    writer.on("error", (error) => { this.#error = error.message; this.#resume(); });
    writer.on("drain", () => this.#resume());
  }

  static async create(path: string, reserve: (bytes: number) => number): Promise<ShellOutputLog> {
    const file = await open(path, "wx", 0o600);
    return new ShellOutputLog(path, file.createWriteStream(), reserve);
  }

  append(chunk: string, source: Readable): void {
    if (this.#error) { this.#truncated = true; return; }
    if (this.#truncated) return;
    const bytes = Buffer.from(chunk);
    let count = this.reserve(Math.min(bytes.length, MAX_COMMAND_LOG_BYTES - this.#written));
    // A log prefix remains valid UTF-8 even when its byte quota cuts a character.
    while (count > 0 && count < bytes.length && (bytes[count]! & 0xc0) === 0x80) count--;
    if (count < bytes.length) this.#truncated = true;
    if (!count) return;
    this.#written += count;
    if (!this.writer.write(bytes.subarray(0, count))) {
      this.#paused.add(source);
      source.pause();
    }
  }

  get truncated(): boolean { return this.#truncated; }
  get error(): string | undefined { return this.#error; }

  finish(): Promise<void> {
    if (!this.#finishing) {
      this.writer.end();
      this.#finishing = this.#closed;
    }
    return this.#finishing;
  }

  #resume(): void {
    for (const source of this.#paused) source.resume();
    this.#paused.clear();
  }
}
