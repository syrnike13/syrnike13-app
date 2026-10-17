import type { ComponentProps } from 'react'
import { HoverCard as Primitive } from 'radix-ui'
import { usePortalContainer } from '../portal-container'
import { cn } from '../../lib/cn'

export const HoverCard = Primitive.Root
export const HoverCardTrigger = Primitive.Trigger

export function HoverCardContent({
  className,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  const container = usePortalContainer()
  return (
    <Primitive.Portal container={container ?? undefined}>
      <Primitive.Content
        className={cn(
          'z-50 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg outline-hidden',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  )
}
