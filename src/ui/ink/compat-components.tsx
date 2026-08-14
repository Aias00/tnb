import type { ComponentProps, ReactNode } from 'react'
import BaseBox from './components/Box.js'
import BaseText from './components/Text.js'
import type { Color } from './styles.js'

const namedColors = {
  black: 'ansi:black',
  red: 'ansi:red',
  green: 'ansi:green',
  yellow: 'ansi:yellow',
  blue: 'ansi:blue',
  magenta: 'ansi:magenta',
  cyan: 'ansi:cyan',
  white: 'ansi:white',
  gray: 'ansi:blackBright',
  grey: 'ansi:blackBright',
} as const satisfies Record<string, Color>

type NamedColor = keyof typeof namedColors
type TextProps = Omit<ComponentProps<typeof BaseText>, 'color' | 'backgroundColor' | 'bold' | 'dim'> & {
  color?: Color | NamedColor
  backgroundColor?: Color | NamedColor
  bold?: boolean
  dim?: boolean
  dimColor?: boolean
}

function resolveColor(color: Color | NamedColor | undefined): Color | undefined {
  return color && color in namedColors
    ? namedColors[color as NamedColor]
    : color as Color | undefined
}

export function Text({
  color,
  backgroundColor,
  dim,
  dimColor,
  children,
  ...props
}: TextProps): ReactNode {
  const weight = props.bold
    ? { bold: true as const }
    : dim ?? dimColor
      ? { dim: true as const }
      : {}
  const { bold: _bold, ...rest } = props
  return <BaseText {...rest} {...weight} color={resolveColor(color)} backgroundColor={resolveColor(backgroundColor)}>{children}</BaseText>
}

export type BoxProps = Omit<
  ComponentProps<typeof BaseBox>,
  'borderColor' | 'borderTopColor' | 'borderBottomColor' | 'borderLeftColor' | 'borderRightColor' | 'backgroundColor'
> & {
  borderColor?: Color | NamedColor
  borderTopColor?: Color | NamedColor
  borderBottomColor?: Color | NamedColor
  borderLeftColor?: Color | NamedColor
  borderRightColor?: Color | NamedColor
  backgroundColor?: Color | NamedColor
}

export function Box({
  borderColor,
  borderTopColor,
  borderBottomColor,
  borderLeftColor,
  borderRightColor,
  backgroundColor,
  ...props
}: BoxProps): ReactNode {
  return <BaseBox {...props}
    borderColor={resolveColor(borderColor)}
    borderTopColor={resolveColor(borderTopColor)}
    borderBottomColor={resolveColor(borderBottomColor)}
    borderLeftColor={resolveColor(borderLeftColor)}
    borderRightColor={resolveColor(borderRightColor)}
    backgroundColor={resolveColor(backgroundColor)}
  />
}
export type { TextProps }
