import type { DOMElement } from './dom.js'
import type { Styles, TextStyles } from './styles.js'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-root': HostProps
      'ink-box': HostProps
      'ink-text': HostProps
      'ink-virtual-text': HostProps
      'ink-link': HostProps
      'ink-progress': HostProps
      'ink-raw-ansi': HostProps
    }
  }
}

type HostProps = {
  children?: React.ReactNode
  ref?: React.Ref<DOMElement>
  style?: Styles
  textStyles?: TextStyles
  [name: string]: unknown
}
