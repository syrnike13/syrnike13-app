import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'

import { cn } from '../../lib/cn'

const listItemVariants = cva(
  'flex w-full min-w-0 items-center gap-3 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'rounded-md px-3 py-2 hover:bg-accent hover:text-accent-foreground',
        flush: 'border-b border-border px-4 py-3 last:border-b-0 hover:bg-accent/60',
        inset:
          'rounded-md border border-border bg-card px-4 py-3 hover:bg-accent/60',
      },
      tone: {
        default: '',
        sidebar:
          'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
      },
      active: {
        true: 'bg-accent text-accent-foreground',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      tone: 'default',
      active: false,
    },
  },
)

function ListItem({
  className,
  variant,
  tone,
  active,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof listItemVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="list-item"
      data-active={active ? 'true' : undefined}
      className={cn(listItemVariants({ variant, tone, active }), className)}
      {...props}
    />
  )
}

export { ListItem, listItemVariants }
