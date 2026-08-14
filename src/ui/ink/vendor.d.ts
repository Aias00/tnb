declare module 'bidi-js' {
  type EmbeddingLevels = {
    levels: Uint8Array
    paragraphs: Array<{ start: number; end: number; level: number }>
  }

  type Bidi = {
    getEmbeddingLevels(text: string, direction?: 'ltr' | 'rtl' | 'auto'): EmbeddingLevels
    getReorderedString(text: string, levels: EmbeddingLevels): string
  }

  const createBidi: () => Bidi
  export default createBidi
}

declare module 'signal-exit' {
  type SignalExit = {
    (
    callback: (code: number | null, signal: string | null) => void,
    options?: { alwaysLast?: boolean },
    ): void
    unload(): void
  }
  const signalExit: SignalExit
  export default signalExit
}
