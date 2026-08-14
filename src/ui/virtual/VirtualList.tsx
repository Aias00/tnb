import React, { type ReactNode } from 'react'
import { Box, type ScrollBoxHandle } from '../ink/index.js'
import { useVirtualScroll } from './use-virtual-scroll.js'

export type VirtualListProps<T> = {
  items: readonly T[]
  itemKey(item: T): string
  columns: number
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  renderItem(item: T, index: number): ReactNode
}

export function VirtualList<T>({
  items,
  itemKey,
  columns,
  scrollRef,
  renderItem,
}: VirtualListProps<T>): ReactNode {
  const keys = React.useMemo(() => items.map(itemKey), [itemKey, items])
  const {
    range: [start, end],
    topSpacer,
    bottomSpacer,
    measureRef,
    spacerRef,
  } = useVirtualScroll(scrollRef, keys, columns)

  return (
    <>
      <Box ref={spacerRef} height={topSpacer} flexShrink={0} />
      {items.slice(start, end).map((item, offset) => {
        const index = start + offset
        const key = keys[index]!
        return (
          <Box key={key} ref={measureRef(key)} flexDirection="column" flexShrink={0}>
            {renderItem(item, index)}
          </Box>
        )
      })}
      <Box height={bottomSpacer} flexShrink={0} />
    </>
  )
}
