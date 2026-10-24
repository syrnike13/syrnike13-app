import type { ReactNode } from 'react'

import { shellContentSurface, shellDivider } from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'

type ShellContentFrameProps = {
  children: ReactNode
}

/** Основная область shell: только верхняя граница, края окна без линий. */
export function ShellContentFrame({ children }: ShellContentFrameProps) {
  return (
    <main
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-t',
        shellDivider,
        shellContentSurface,
      )}
    >
      {children}
    </main>
  )
}
