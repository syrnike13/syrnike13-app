import type { Channel, Server } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { useMemo } from 'react'

import { UserAvatar } from '#/components/user/user-avatar'
import { UserInteractiveShell } from '#/components/user/user-interactive-shell'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { SidebarMenuButton } from '@syrnike13/ui/primitives/sidebar'
import {
  flattenMemberListSections,
  groupServerMembersForSidebar,
  memberDisplayColour,
} from '#/features/sync/member-list-groups'
import {
  listServerMembers,
  memberRoleEntries,
  type ServerMemberEntry,
} from '@syrnike13/client/sync/selectors'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { canViewChannelDraft } from '#/features/authorization/permission-draft'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'

type ChannelMemberSidebarProps = {
  channel: Extract<Channel, { channel_type: 'TextChannel' }>
}

function MemberListSectionHeader({
  title,
  count,
}: {
  title: string
  count: number
}) {
  return (
    <li className="px-2 pt-5 pb-1 first:pt-2">
      <h3 className="truncate text-sm leading-4.5 font-medium tracking-tight text-muted-foreground">
        {title} — {count}
      </h3>
    </li>
  )
}

function MemberSidebarRow({
  entry,
  server,
  serverId,
  serverName,
  nameColour,
  dimmed,
  showStatus,
  inVoice,
}: {
  entry: ServerMemberEntry
  server: Server | undefined
  serverId: string
  serverName?: string
  nameColour?: string
  dimmed?: boolean
  showStatus?: boolean
  inVoice: boolean
}) {
  const { member, user } = entry
  const displayName = user.display_name ?? user.username
  const customStatus = user.status?.text?.trim()

  return (
    <li>
      <UserInteractiveShell
        user={user}
        serverId={serverId}
        serverName={serverName}
        roles={memberRoleEntries(server, member)}
        side="left"
        align="start"
        inVoice={inVoice}
      >
        <SidebarMenuButton
          size="lg"
          data-avatar-hover-scope=""
          className={cn(dimmed && 'opacity-60')}
        >
          <UserAvatar
            user={user}
            className="size-8"
            hoverScope="parent"
            showPresence
          />
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                'truncate leading-5',
                nameColour && 'text-(--member-name-color)',
              )}
              style={
                nameColour
                  ? ({ '--member-name-color': nameColour } as CSSVars)
                  : undefined
              }
            >
              {displayName}
            </p>
            {showStatus && customStatus ? (
              <p className="truncate text-xs leading-3.5 text-muted-foreground">
                {customStatus}
              </p>
            ) : null}
          </div>
        </SidebarMenuButton>
      </UserInteractiveShell>
    </li>
  )
}

export function ChannelMemberSidebar({ channel }: ChannelMemberSidebarProps) {
  const t = useTranslations('chat')
  const server = useSyncStore((s) => s.servers[channel.server])
  const members = useSyncStore((s) => listServerMembers(s, channel.server))
  const userIdsInVoice = useSyncStore((s) => {
    const ids = new Set<string>()
    for (const channelMap of Object.values(s.voiceParticipants)) {
      for (const userId of Object.keys(channelMap)) {
        ids.add(userId)
      }
    }
    return ids
  })

  const visibleMembers = useMemo(() => {
    if (channel.channel_type !== 'TextChannel' || !server) return members

    return members.filter((entry) =>
      canViewChannelDraft(
        server,
        channel,
        entry.member,
        entry.user._id,
      ),
    )
  }, [channel, members, server])

  const sidebarItems = useMemo(() => {
    const sections = groupServerMembersForSidebar(server, visibleMembers)
    return flattenMemberListSections(sections, t)
  }, [server, visibleMembers])

  return (
    <aside className="theme-surface-content gradient-surface-content hidden min-h-0 w-66 shrink-0 flex-col border-l border-shell-divider text-card-foreground lg:flex">
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-0.5 p-2">
          {sidebarItems.map((item) =>
            item.kind === 'header' ? (
              <MemberListSectionHeader
                key={item.key}
                title={item.title}
                count={item.count}
              />
            ) : (
              <MemberSidebarRow
                key={item.key}
                entry={item.entry}
                server={server}
                serverId={channel.server}
                serverName={server?.name}
                nameColour={memberDisplayColour(server, item.entry.member)}
                dimmed={item.sectionType === 'offline'}
                showStatus={item.sectionType !== 'offline'}
                inVoice={userIdsInVoice.has(item.entry.user._id)}
              />
            ),
          )}
          {visibleMembers.length === 0 ? (
            <li>
              <Empty size="sm">
                <EmptyDescription>{t('noMembers')}</EmptyDescription>
              </Empty>
            </li>
          ) : null}
        </ul>
      </ScrollArea>
    </aside>
  )
}
