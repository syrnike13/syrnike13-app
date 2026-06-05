import { useState, type ReactElement } from 'react'
import type { User } from '@syrnike13/api-types'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import {
  UserProfileCard,
  type UserProfileCardProps,
} from '#/components/user/user-profile-card'
import { cn } from '#/lib/utils'

function focusOutsideRelatedTarget(event: unknown): EventTarget | null {
  if (!event || typeof event !== 'object') return null

  const detail = (event as { detail?: { originalEvent?: FocusEvent } }).detail
  const fromOriginal = detail?.originalEvent?.relatedTarget
  if (fromOriginal != null) return fromOriginal

  if ('relatedTarget' in event) {
    return (event as { relatedTarget: EventTarget | null }).relatedTarget
  }

  return null
}

function shouldKeepProfilePopoverOpen(event: unknown): boolean {
  const relatedTarget = focusOutsideRelatedTarget(event)
  if (relatedTarget == null) {
    return true
  }

  if (!(relatedTarget instanceof Element)) {
    return false
  }

  return Boolean(
    relatedTarget.closest('[data-slot="dialog-content"]') ||
      relatedTarget.closest('[data-slot="dialog-overlay"]'),
  )
}

function isRoleDialogTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(
    target.closest('[data-slot="dialog-content"]') ||
      target.closest('[data-slot="dialog-overlay"]'),
  )
}

type UserProfilePopoverProps = Omit<UserProfileCardProps, 'user' | 'onClose'> & {
  user: User
  children: ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  className?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function UserProfilePopover({
  user,
  children,
  side = 'left',
  align = 'start',
  className,
  open: openProp,
  onOpenChange: onOpenChangeProp,
  ...cardProps
}: UserProfilePopoverProps) {
  const [openInternal, setOpenInternal] = useState(false)
  const open = openProp ?? openInternal
  const setOpen = onOpenChangeProp ?? setOpenInternal

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={8}
        collisionPadding={16}
        className={cn(
          'z-[200] w-[min(340px,calc(100vw-1rem))] overflow-hidden border-0 bg-muted p-0 text-foreground shadow-xl ring-1 ring-border',
          className,
        )}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onFocusOutside={(event) => {
          if (shouldKeepProfilePopoverOpen(event)) {
            event.preventDefault()
          }
        }}
        onInteractOutside={(event) => {
          if (isRoleDialogTarget(event.target)) {
            event.preventDefault()
          }
        }}
        onPointerDownOutside={(event) => {
          if (isRoleDialogTarget(event.target)) {
            event.preventDefault()
          }
        }}
      >
        <UserProfileCard
          user={user}
          {...cardProps}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}
