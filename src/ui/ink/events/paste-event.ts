import { TerminalEvent } from './terminal-event.js'

export class PasteEvent extends TerminalEvent {
  constructor(readonly text: string) {
    super('paste', { bubbles: true, cancelable: true })
  }
}
