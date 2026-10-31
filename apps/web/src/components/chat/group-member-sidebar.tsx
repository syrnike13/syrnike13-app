import type { Channel, User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { useId } from 'react'

import { CrownIcon } from '#/components/icons'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserInteractiveShell } from '#/components/user/user-interactive-shell'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@syrnike13/ui/primitives/sidebar'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'

type GroupChannel = Extract<Channel, { channel_type: 'Group' }>

function displayName(user: User) {
  return user.display_name ?? user.username
}

/** Member list of a group DM: everyone in the group, the owner first. */
export function GroupMemberSidebar({ channel }: { channel: GroupChannel }) {
  const t = useTranslations('chat')
  const headingId = useId()
  const users = useSyncStore((s) => s.users)
  const members = channel.recipients
    .map((id) => users[id])
    .filter((user): user is User => Boolean(user))
    .sort((a, b) => {
      if (a._id === channel.owner) return -1
      if (b._id === channel.owner) return 1
      return displayName(a).localeCompare(displayName(b))
    })

  return (
    <aside
      aria-labelledby={headingId}
      className="hidden w-66 shrink-0 flex-col border-l border-shell-divider lg:flex"
    >
      <ScrollArea className="min-h-0 flex-1">
        <section className="flex flex-col gap-1 p-2">
          <h2 id={headingId} className="px-2 pt-4 pb-1 text-sm font-medium text-muted-foreground">
            {t('groupMembers', { count: members.length })}
          </h2>
          <SidebarMenu>
            {members.map((user) => (
              <SidebarMenuItem key={user._id}>
                <UserInteractiveShell user={user} side="left" align="start">
                  <SidebarMenuButton size="lg" data-avatar-hover-scope="">
                    <UserAvatar user={user} className="size-8" hoverScope="parent" showPresence />
                    <span className="min-w-0 flex-1 truncate">{displayName(user)}</span>
                    {user._id === channel.owner ? (
                      <CrownIcon aria-label={t('groupOwner')} className="size-4 text-warning" />
                    ) : null}
                  </SidebarMenuButton>
                </UserInteractiveShell>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </section>
      </ScrollArea>
    </aside>
  )
}
