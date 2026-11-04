import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { ptyCommand } from '../helpers/pty-command'

describe('custom renderer PTY lifecycle', () => {
  test('owns alternate screen, terminal events, and clean exit', async () => {
    const fixture = resolve(import.meta.dir, '../fixtures/custom-renderer-tui.tsx')
    const bunExecutable = process.execPath
    const transcript = `/tmp/tnb-custom-renderer-${process.pid}.typescript`
    const terminal = ptyCommand(transcript, [bunExecutable, fixture])
    const child = spawn(
      terminal.file, terminal.args,
      {
        cwd: resolve(import.meta.dir, '../..'),
        env: { ...process.env, TERM: 'xterm-256color' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    let output = ''
    const waiters: Array<{ text: string; resolve(): void }> = []
    let timeout: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`PTY fixture did not become ready or exit: ${JSON.stringify(output.slice(-600))}`)), 5_000)
    })
    const waitForOutput = (text: string) => Promise.race([
      output.includes(text) ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ text, resolve })),
      deadline,
      exited.then(async (code) => { throw new Error(`PTY exited before output (${code}): ${await errorTask}`) }),
    ])
    const outputTask = (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of child.stdout) {
        output += decoder.decode(chunk, { stream: true })
        for (const waiter of waiters) if (output.includes(waiter.text)) waiter.resolve()
      }
      output += decoder.decode()
    })()
    const errorTask = (async () => { let error = ''; for await (const chunk of child.stderr) error += String(chunk); return error })()
    const send = (input: string) => new Promise<void>((resolve, reject) => { child.stdin.write(input, (error) => error ? reject(error) : resolve()) })

    try {
      // Input before raw mode is enabled is echoed by the PTY driver. Wait for
      // actual terminal readiness rather than guessing an interpreter startup delay.
      await waitForOutput('\u001b[?2004h')
      await send('\u001b[200~line one\n界 emoji 👨‍👩‍👧‍👦\nline three\nline four\u001b[201~')
      await waitForOutput('[Pasted text #1 +3 lines]')
      await send('\u001b[A\u001b[B\u001b[<64;10;10M\u0003')
      await waitForOutput('Press Ctrl+C again to exit')
      await send('\u0003')
      child.stdin.end()
      const exitCode = await Promise.race([exited, deadline])
      await outputTask
      const error = await errorTask

      expect(exitCode, `stderr=${error}; output=${JSON.stringify(output.slice(-1000))}`).toBe(0)
      expect(error).toBe('')
      expect(output).toContain('\u001b[?1049h')
      expect(output).toContain('\u001b[?1006h')
      expect(output).toContain('fixture-model')
      expect(output).toContain('[Pasted text #1 +3 lines]')
      expect(output).not.toContain('[200~')
      expect(output).not.toContain('[201~')
      expect(output).not.toContain('�')
      expect(output).toContain('Press Ctrl+C again to exit')
      expect(output).toContain('\u001b[?1006l')
      expect(output).toContain('\u001b[?1049l')
      expect(output).toContain('Resume this session with:')
      expect(output).toContain('tnb --resume renderer-pty-fixture')
      expect(output.lastIndexOf('\u001b[?1049l')).toBeLessThan(output.indexOf('Resume this session with:'))
      expect(() => process.kill(child.pid!, 0)).toThrow()
    } finally {
      clearTimeout(timeout!)
      if (child.exitCode === null) child.kill()
      await rm(transcript, { force: true })
    }
  }, 10_000)
})
