import { spawn } from 'node:child_process'

let lastInteractionAt = Date.now()
let lastScrollAt = 0

export function updateLastInteractionTime(): void {
  lastInteractionAt = Date.now()
}

export function flushInteractionTime(): void {
  lastInteractionAt = Date.now()
}

export function markScrollActivity(): void {
  lastScrollAt = Date.now()
}

export function getRendererActivity(): {
  lastInteractionAt: number
  lastScrollAt: number
} {
  return { lastInteractionAt, lastScrollAt }
}

export function isEnvTruthy(value: string | boolean | undefined): boolean {
  if (typeof value === 'boolean') return value
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function logForDebugging(
  message: string,
  details?: Record<string, unknown>,
): void {
  if (!isEnvTruthy(process.env.TNB_DEBUG)) return
  const suffix = details ? ` ${JSON.stringify(details)}` : ''
  process.stderr.write(`[tnb:renderer] ${message}${suffix}\n`)
}

export function logError(error: unknown): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  logForDebugging(message)
}

export function stopCapturingEarlyInput(): void {
  // tnb does not install a pre-render stdin capture layer. Keeping this
  // lifecycle hook explicit preserves the renderer contract for a future
  // startup buffer without changing terminal input ownership today.
}

export function isMouseClicksDisabled(): boolean {
  return isEnvTruthy(process.env.TNB_DISABLE_MOUSE)
}

function detectTerminal(): string | null {
  if (process.env.TERM === 'xterm-ghostty') return 'ghostty'
  if (process.env.TERM?.includes('kitty') || process.env.KITTY_WINDOW_ID) return 'kitty'
  if (process.env.TERM_PROGRAM) return process.env.TERM_PROGRAM
  if (process.env.TMUX) return 'tmux'
  if (process.env.STY) return 'screen'
  if (process.env.WT_SESSION) return 'windows-terminal'
  return process.env.TERM ?? null
}

export const env = {
  terminal: detectTerminal(),
}

export function gte(a: string, b: string): boolean {
  return Bun.semver.order(a, b) >= 0
}

type ExecFileOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  useCwd?: boolean
  env?: NodeJS.ProcessEnv
  stdin?: 'ignore' | 'inherit' | 'pipe'
  input?: string
}

export function execFileNoThrow(
  file: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  return new Promise(resolve => {
    const child = spawn(file, args, {
      cwd: options.useCwd === false ? undefined : process.cwd(),
      env: options.env,
      signal: options.abortSignal,
      stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const finish = (code: number, error?: string): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        ...(error ? { error } : {}),
      })
    }
    child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.on('error', error => finish(1, error.message))
    child.on('close', code => finish(code ?? 1))
    if (options.input !== undefined && child.stdin) child.stdin.end(options.input)
    else child.stdin?.end()
    const timer = options.timeout
      ? setTimeout(() => {
          child.kill('SIGTERM')
          finish(1, `Timed out after ${options.timeout}ms`)
        }, options.timeout)
      : undefined
    timer?.unref()
  })
}
