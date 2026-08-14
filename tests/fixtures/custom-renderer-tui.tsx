import { runTui } from '../../src/ui/app.js'

await runTui({
  model: 'fixture-model',
  permissionMode: 'default',
  sessionIdFactory: () => 'renderer-pty-fixture',
  async runTurn() {},
  fullscreen: true,
  resumeHint: () => '\nResume this session with:\ntnb --resume renderer-pty-fixture\n',
})
