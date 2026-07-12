import type { ReactNode } from 'react'

import { shellContentSurface, shellDivider } from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'

type ShellContentFrameProps = {
  children: ReactNode
}

export function ShellContentFrame({ children }: ShellContentFrameProps) {
  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-l-0 shadow-sm',
        shellDivider,
        shellContentSurface,
      )}
    >
      {children}
    </div>
  )
}
