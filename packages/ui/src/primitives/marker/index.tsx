import type * as React from 'react'

import { cn } from '../../lib/cn'

function Marker({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="marker"
      className={cn(
        'flex min-w-0 items-center gap-2 text-sm font-medium text-foreground',
        className,
      )}
      {...props}
    />
  )
}

function MarkerIcon({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="marker-icon"
      className={cn('shrink-0 text-muted-foreground [&_svg]:size-4', className)}
      {...props}
    />
  )
}

function MarkerContent({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="marker-content"
      className={cn('min-w-0 truncate', className)}
      {...props}
    />
  )
}

export { Marker, MarkerContent, MarkerIcon }
