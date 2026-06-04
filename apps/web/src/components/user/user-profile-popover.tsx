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
          'z-[200] w-[min(340px,calc(100vw-1rem))] overflow-hidden border-border bg-muted p-0 text-foreground shadow-xl',
          className,
        )}
        onOpenAutoFocus={(event) => event.preventDefault()}
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
