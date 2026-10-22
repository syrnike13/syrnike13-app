import type { CSSProperties } from 'react'

/** CSSProperties that also allows CSS custom properties. */
export type CSSVars = CSSProperties &
  Record<`--${string}`, string | number | undefined>
