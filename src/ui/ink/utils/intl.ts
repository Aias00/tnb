let graphemeSegmenter: Intl.Segmenter | undefined

export function getGraphemeSegmenter(): Intl.Segmenter {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, {
    granularity: 'grapheme',
  })
  return graphemeSegmenter
}
