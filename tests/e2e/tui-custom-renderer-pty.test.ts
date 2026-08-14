import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'

describe('custom renderer PTY lifecycle', () => {
  test('owns alternate screen, terminal events, and clean exit', async () => {
    const fixture = resolve(import.meta.dir, '../fixtures/custom-renderer-tui.tsx')
    const bunExecutable = join(process.env.HOME ?? '', '.bun', 'bin', 'bun')
    const transcript = `/tmp/tnb-custom-renderer-${process.pid}.typescript`
    const command = `(sleep 0.2; printf '\\033[<64;10;10M'; sleep 0.05; printf '\\003'; sleep 0.2; printf '\\003') | script -q ${JSON.stringify(transcript)} ${JSON.stringify(bunExecutable)} ${JSON.stringify(fixture)}`
    const child = Bun.spawn(
      ['sh', '-c', command],
      {
        cwd: resolve(import.meta.dir, '../..'),
        env: { ...process.env, TERM: 'xterm-256color' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    try {
      const exitCode = await Promise.race([
        child.exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('PTY fixture did not exit')), 5_000),
        ),
      ])
      const output = await new Response(child.stdout).text()
      const error = await new Response(child.stderr).text()

      expect(exitCode, `stderr=${error}; output=${JSON.stringify(output.slice(-1000))}`).toBe(0)
      expect(error).toBe('')
      expect(output).toContain('\u001b[?1049h')
      expect(output).toContain('\u001b[?1006h')
      expect(output).toContain('fixture-model')
      expect(output).toContain('Press Ctrl+C again to exit')
      expect(output).toContain('\u001b[?1006l')
      expect(output).toContain('\u001b[?1049l')
      expect(output).toContain('Resume this session with:')
      expect(output).toContain('tnb --resume renderer-pty-fixture')
      expect(output.lastIndexOf('\u001b[?1049l')).toBeLessThan(output.indexOf('Resume this session with:'))
      expect(() => process.kill(child.pid, 0)).toThrow()
    } finally {
      if (child.exitCode === null) child.kill()
    }
  }, 10_000)
})
