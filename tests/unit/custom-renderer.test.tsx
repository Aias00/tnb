import { describe, expect, test } from 'bun:test'
import { renderCompatibilityFixture } from '../../src/ui/ink/compat-render.js'

describe('custom Ink renderer compatibility boundary', () => {
  test('renders a React tree through the local reconciler and Yoga engine', () => {
    expect(renderCompatibilityFixture()).toEqual([
      'tnb renderer',
      'selection · scroll · virtual',
      'list',
    ])
  })
})
