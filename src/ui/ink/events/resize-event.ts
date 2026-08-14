import { TerminalEvent } from './terminal-event.js'

export class ResizeEvent extends TerminalEvent {
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super('resize', { bubbles: false, cancelable: false })
  }
}
