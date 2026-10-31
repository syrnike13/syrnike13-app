import { useState, type ReactElement } from 'react'
import type { User } from '@syrnike13/api-types'

import {
  ContextMenu,
  ContextMenuTrigger,
} from '@syrnike13/ui/primitives/context-menu'
import { UserContextMenuContent } from '#/components/user/user-context-menu-content'
import { UserGlobalProfileDialog } from '#/components/user/user-global-profile-dialog'
import { UserProfilePopover } from '#/components/user/user-profile-popover'
import type { MemberRoleEntry } from '@syrnike13/client/sync/selectors'
import { useAuth } from '#/features/auth/auth-context'

type UserInteractiveShellProps = {
  user: User
  serverId?: string
  serverName?: string
  roles?: MemberRoleEntry[]
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  inVoice?: boolean
  children: ReactElement
  onProfileOpenChange?: (open: boolean) => void
}

export function UserInteractiveShell({
  user,
  serverId,
  serverName,
  roles,
  side = 'left',
  align = 'start',
  inVoice = false,
  children,
  onProfileOpenChange,
}: UserInteractiveShellProps) {
  const auth = useAuth()
  const [profileOpen, setProfileOpen] = useState(false)
  const [globalProfileOpen, setGlobalProfileOpen] = useState(false)
  const isSelf = user._id === auth.user?._id

  function openGlobalProfile() {
    setProfileOpen(false)
    onProfileOpenChange?.(false)
    setGlobalProfileOpen(true)
  }

  return (
    <ContextMenu>
      <UserProfilePopover
        user={user}
        serverId={serverId}
        serverName={serverName}
        roles={roles}
        side={side}
        align={align}
        open={profileOpen}
        onOpenChange={(open) => {
          setProfileOpen(open)
          onProfileOpenChange?.(open)
        }}
        onOpenGlobalProfile={openGlobalProfile}
      >
        <ContextMenuTrigger render={children} />
      </UserProfilePopover>
      <UserContextMenuContent
        user={user}
        serverId={serverId}
        isSelf={isSelf}
        inVoice={inVoice}
        onOpenProfile={openGlobalProfile}
      />
      <UserGlobalProfileDialog
        user={user}
        serverId={serverId}
        open={globalProfileOpen}
        onOpenChange={setGlobalProfileOpen}
      />
    </ContextMenu>
  )
}
