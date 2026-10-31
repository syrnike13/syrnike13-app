import { createContext, useContext } from 'react'
import { Text as NativeText, type TextProps as NativeTextProps } from 'react-native'

import { cn } from '../../lib/cn'

/**
 * React Native text does not inherit styles from a parent `View`, so
 * containers such as `Button` pass their text classes down through context.
 */
export const TextClassContext = createContext<string | undefined>(undefined)

export type TextProps = NativeTextProps & { className?: string }

function Text({ className, ...props }: TextProps) {
  const inherited = useContext(TextClassContext)
  return (
    <NativeText
      className={cn('text-base text-foreground', inherited, className)}
      {...props}
    />
  )
}

export { Text }
