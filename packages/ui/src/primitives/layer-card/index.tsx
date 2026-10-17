import type * as React from 'react'

import { cn } from '../../lib/cn'

function LayerCard({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="layer-card"
      className={cn(
        'rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm',
        className,
      )}
      {...props}
    />
  )
}

function LayerCardPrimary({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="layer-card-primary"
      className={cn('flex min-w-0 items-center gap-3', className)}
      {...props}
    />
  )
}

function LayerCardSecondary({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="layer-card-secondary"
      className={cn('min-w-0 text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

function LayerCardStrip({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="layer-card-strip"
      className={cn('flex items-center gap-2 border-t border-border pt-3', className)}
      {...props}
    />
  )
}

export { LayerCard, LayerCardPrimary, LayerCardSecondary, LayerCardStrip }
