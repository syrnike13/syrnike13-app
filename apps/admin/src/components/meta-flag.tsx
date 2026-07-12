import type { ReactNode } from 'react'

import { cn } from '#/lib/utils'

export function MetaFlag({
  children,
  tone = 'muted',
}: {
  children: ReactNode
  tone?: 'muted' | 'ok' | 'accent'
}) {
  return (
    <span
      className={cn(
        'text-[11px] leading-none',
        tone === 'ok' && 'text-success',
        tone === 'accent' && 'text-primary',
        tone === 'muted' && 'text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}
