import type { ReactElement } from 'react'
import { renderToScreen } from './render-to-screen.js'
import { CellWidth, cellAt } from './screen.js'

export function renderToString(
  element: ReactElement,
  options: { columns?: number } = {},
): string {
  const { screen, height } = renderToScreen(element, options.columns ?? 100)
  return Array.from({ length: height }, (_, row) => {
    let text = ''
    for (let column = 0; column < screen.width; column++) {
      const cell = cellAt(screen, column, row)
      if (cell?.width === CellWidth.SpacerTail) continue
      text += cell?.char ?? ' '
    }
    return text.trimEnd()
  }).join('\n')
}
