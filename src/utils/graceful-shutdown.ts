import { writeSync } from "node:fs";

import instances from "../ui/ink/instances";
import { DISABLE_KITTY_KEYBOARD, DISABLE_MODIFY_OTHER_KEYS } from "../ui/ink/termio/csi";
import { DBP, DFE, DISABLE_MOUSE_TRACKING, EXIT_ALT_SCREEN, SHOW_CURSOR } from "../ui/ink/termio/dec";
import {
  CLEAR_ITERM2_PROGRESS,
  CLEAR_TAB_STATUS,
  CLEAR_TERMINAL_TITLE,
  supportsTabStatus,
  wrapForMultiplexer,
} from "../ui/ink/termio/osc";
import { runCleanupFunctions } from "./cleanup-registry";

let shutdownInProgress = false;
let failsafeTimer: ReturnType<typeof setTimeout> | undefined;
let orphanCheckInterval: ReturnType<typeof setInterval> | undefined;
let resumeHint: (() => string | undefined) | undefined;
let resumeHintPrinted = false;
let handlersInstalled = false;

export function setShutdownResumeHint(getHint: (() => string | undefined) | undefined): () => void {
  resumeHint = getHint;
  return () => {
    if (resumeHint === getHint) resumeHint = undefined;
  };
}

export function setupGracefulShutdown(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  process.on("SIGINT", () => {
    if (process.argv.includes("-p") || process.argv.includes("--print")) return;
    void gracefulShutdown(130);
  });
  process.on("SIGTERM", () => void gracefulShutdown(143));
  if (process.platform !== "win32") {
    process.on("SIGHUP", () => void gracefulShutdown(129));
    if (process.stdin.isTTY) {
      orphanCheckInterval = setInterval(() => {
        if (process.stdout.writable && process.stdin.readable) return;
        if (orphanCheckInterval) clearInterval(orphanCheckInterval);
        orphanCheckInterval = undefined;
        void gracefulShutdown(129);
      }, 30_000);
      orphanCheckInterval.unref();
    }
  }
}

export async function gracefulShutdown(exitCode = 0): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  process.exitCode = exitCode;

  failsafeTimer = setTimeout(() => {
    cleanupTerminalModes();
    printResumeHint();
    forceExit(exitCode);
  }, 5_000);
  failsafeTimer.unref();

  cleanupTerminalModes();
  printResumeHint();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      runCleanupFunctions(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 2_000);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  forceExit(exitCode);
}

export function cleanupTerminalModes(): void {
  if (!process.stdout.isTTY) return;
  try {
    writeSync(1, DISABLE_MOUSE_TRACKING);
    const instance = instances.get(process.stdout);
    if (instance?.isAltScreenActive) {
      try {
        instance.unmount();
      } catch {
        writeSync(1, EXIT_ALT_SCREEN);
      }
    }
    instance?.drainStdin();
    instance?.detachForShutdown();
    writeSync(1, DISABLE_MODIFY_OTHER_KEYS);
    writeSync(1, DISABLE_KITTY_KEYBOARD);
    writeSync(1, DFE);
    writeSync(1, DBP);
    writeSync(1, SHOW_CURSOR);
    writeSync(1, CLEAR_ITERM2_PROGRESS);
    if (supportsTabStatus()) writeSync(1, wrapForMultiplexer(CLEAR_TAB_STATUS));
    if (process.env.TNB_DISABLE_TERMINAL_TITLE !== "1") {
      if (process.platform === "win32") process.title = "";
      else writeSync(1, CLEAR_TERMINAL_TITLE);
    }
  } catch {
    // The TTY can already be revoked after SIGHUP or terminal closure.
  }
}

function printResumeHint(): void {
  if (resumeHintPrinted || !process.stdout.isTTY) return;
  try {
    const hint = resumeHint?.();
    if (!hint) return;
    writeSync(1, hint);
    resumeHintPrinted = true;
  } catch {
    // The TTY or session store may already be unavailable during shutdown.
  }
}

function forceExit(exitCode: number): never {
  if (failsafeTimer) clearTimeout(failsafeTimer);
  failsafeTimer = undefined;
  try {
    instances.get(process.stdout)?.drainStdin();
  } catch {
    // The input descriptor may have been revoked.
  }
  try {
    process.exit(exitCode);
  } catch (error) {
    if (process.env.NODE_ENV === "test") throw error;
    process.kill(process.pid, "SIGKILL");
  }
  return undefined as never;
}

export function resetGracefulShutdownForTesting(): void {
  shutdownInProgress = false;
  resumeHintPrinted = false;
  resumeHint = undefined;
  if (failsafeTimer) clearTimeout(failsafeTimer);
  failsafeTimer = undefined;
}
