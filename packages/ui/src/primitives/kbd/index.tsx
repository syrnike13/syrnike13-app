import type * as React from 'react'

import { cn } from '../../lib/cn'

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export { Kbd }
