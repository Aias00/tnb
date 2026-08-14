import React from 'react'
import Box from './components/Box.js'
import Text from './components/Text.js'
import { renderToScreen } from './render-to-screen.js'
import { cellAt } from './screen.js'

export function RendererCompatibilityFixture(): React.ReactNode {
  return (
    <Box flexDirection="column" width={32}>
      <Text bold>tnb renderer</Text>
      <Text>selection · scroll · virtual list</Text>
    </Box>
  )
}

export function renderCompatibilityFixture(width = 40): string[] {
  const { screen, height } = renderToScreen(
    <RendererCompatibilityFixture />,
    width,
  )
  return Array.from({ length: height }, (_, row) => {
    let text = ''
    for (let column = 0; column < screen.width; column++) {
      text += cellAt(screen, column, row)?.char ?? ' '
    }
    return text.trimEnd()
  })
}
