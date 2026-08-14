import {
  type AnsiCode,
  ansiCodesToString,
  reduceAnsiCodes,
  tokenize,
  undoAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import { stringWidth } from '../stringWidth.js'

function activeStartCodes(codes: AnsiCode[]): AnsiCode[] {
  return reduceAnsiCodes(codes).filter(code => code.code !== code.endCode)
}

export default function sliceAnsi(
  value: string,
  start: number,
  end?: number,
): string {
  const codes: AnsiCode[] = []
  let position = 0
  let output = ''
  let included = false

  for (const token of tokenize(value)) {
    const width =
      token.type === 'ansi' ? 0 : token.fullWidth ? 2 : stringWidth(token.value)
    if (end !== undefined && position >= end) {
      if (token.type === 'ansi' || width > 0 || !included) break
    }
    if (token.type === 'ansi') {
      codes.push(token)
      if (included) output += token.code
      continue
    }
    if (!included && position >= start) {
      if (start > 0 && width === 0) continue
      included = true
      output = ansiCodesToString(activeStartCodes(codes))
    }
    if (included) output += token.value
    position += width
  }

  return output + ansiCodesToString(undoAnsiCodes(activeStartCodes(codes)))
}
