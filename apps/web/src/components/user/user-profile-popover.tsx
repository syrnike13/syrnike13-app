import { useState, type ReactElement } from 'react'
import type { User } from '@syrnike13/api-types'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import {
  UserProfileCard,
  type UserProfileCardProps,
} from '#/components/user/user-profile-card'
import { UserGlobalProfileDialog } from '#/components/user/user-global-profile-dialog'
import { cn } from '#/lib/utils'

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
  onOpenGlobalProfile?: () => void
}

export function UserProfilePopover({
  user,
  children,
  side = 'left',
  align = 'start',
  className,
  open: openProp,
  onOpenChange: onOpenChangeProp,
  onOpenGlobalProfile,
  ...cardProps
}: UserProfilePopoverProps) {
  const [openInternal, setOpenInternal] = useState(false)
  const [globalProfileOpen, setGlobalProfileOpen] = useState(false)
  // Mounted on first open: the dialog subscribes to auth and sync stores.
  const [globalProfileMounted, setGlobalProfileMounted] = useState(false)
  const open = openProp ?? openInternal
  const setOpen = onOpenChangeProp ?? setOpenInternal
  // Without a caller-owned dialog the popover opens the full profile itself,
  // so every popover (feed, mentions, system rows) can reach it.
  const openGlobalProfile =
    onOpenGlobalProfile ??
    (() => {
      setOpen(false)
      setGlobalProfileMounted(true)
      setGlobalProfileOpen(true)
    })

  return (
    <>
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (
          !next &&
          details.reason === 'outside-press' &&
          isRoleDialogTarget(details.event.target as EventTarget | null)
        ) {
          details.cancel()
          return
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger render={children} />
      <PopoverContent
        side={side}
        align={align}
        sideOffset={8}
        className={cn(
          'z-200 w-profile-popover overflow-hidden p-0',
          className,
        )}
        initialFocus={false}
        finalFocus={false}
      >
        <UserProfileCard
          user={user}
          {...cardProps}
          onClose={() => setOpen(false)}
          onOpenGlobalProfile={openGlobalProfile}
        />
      </PopoverContent>
    </Popover>
    {onOpenGlobalProfile || !globalProfileMounted ? null : (
      <UserGlobalProfileDialog
        user={user}
        serverId={cardProps.serverId}
        open={globalProfileOpen}
        onOpenChange={setGlobalProfileOpen}
      />
    )}
    </>
  )
}
