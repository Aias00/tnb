import { stat } from "node:fs/promises";
import { SessionStore, type SessionState } from "./storage";

export type SessionSelection = {
  resume?: string;
  continueLatest: boolean;
  forkSession: boolean;
  sessionId?: string;
  sessionName?: string;
};
export type SessionBootstrapOptions = {
  parsed: SessionSelection;
  configDir: string;
  cwd: string;
  sessionIdFactory(): string;
};

export async function assertSessionIdAvailable(configDir: string, cwd: string, sessionId: string): Promise<void> {
  const session = new SessionStore({ configDir, cwd, sessionId });
  try { await stat(session.filePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error(`Session ID ${sessionId} is already in use`);
}

/** Select/fork only. The execution caller must acquire ownership before reading mutable state. */
export async function selectSession(options: SessionBootstrapOptions) {
  const { parsed, configDir, cwd } = options;
  const sourceSessionId = parsed.continueLatest
    ? await SessionStore.latestSessionId({ configDir, cwd }) : parsed.resume;
  if (parsed.continueLatest && !sourceSessionId) throw new Error("No previous session found for this workspace");
  if (parsed.forkSession) {
    if (!sourceSessionId) throw new Error("--fork-session requires --resume or --continue");
    const targetId = parsed.sessionId ?? options.sessionIdFactory();
    await assertSessionIdAvailable(configDir, cwd, targetId);
    const session = await new SessionStore({ configDir, cwd, sessionId: sourceSessionId }).forkTo(targetId);
    return { session, sourceSessionId };
  }
  const sessionId = sourceSessionId ?? parsed.sessionId ?? options.sessionIdFactory();
  if (parsed.sessionId) await assertSessionIdAvailable(configDir, cwd, parsed.sessionId);
  return { session: new SessionStore({ configDir, cwd, sessionId }), sourceSessionId };
}

/** Startup preview (including explicit fork/title); execution owns the eventual run lock. */
export async function prepareInteractiveSession(options: SessionBootstrapOptions): Promise<{ sessionId: string; resume: boolean; state?: SessionState }> {
  const { session, sourceSessionId } = await selectSession(options);
  if (options.parsed.forkSession && options.parsed.sessionName) await session.setTitle(options.parsed.sessionName);
  return { sessionId: session.sessionId, resume: Boolean(sourceSessionId), ...(sourceSessionId ? { state: await session.readState() } : {}) };
}
