import type { Channel, Server } from '@syrnike13/api-types'
import { useMemo } from 'react'

import { UserAvatar } from '#/components/user/user-avatar'
import { UserInteractiveShell } from '#/components/user/user-interactive-shell'
import { ScrollArea } from '#/components/ui/scroll-area'
import {
  groupServerMembersForSidebar,
  memberDisplayColour,
  type MemberListSection,
} from '#/features/sync/member-list-groups'
import {
  listServerMembers,
  memberRoleEntries,
  type ServerMemberEntry,
} from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { cn } from '#/lib/utils'

type ChannelMemberSidebarProps = {
  channel: Extract<Channel, { channel_type: 'TextChannel' | 'VoiceChannel' }>
}

function MemberListSectionHeader({
  title,
  count,
}: {
  title: string
  count: number
}) {
  return (
    <li className="list-none px-2 pt-3 pb-0.5 first:pt-2">
      <p className="truncate text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title} — {count}
      </p>
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
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none data-[state=open]:bg-accent',
            dimmed && 'opacity-60',
          )}
        >
          <UserAvatar user={user} className="size-8" showPresence />
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-sm font-medium"
              style={nameColour ? { color: nameColour } : undefined}
            >
              {displayName}
            </p>
            {showStatus && customStatus ? (
              <p className="truncate text-[11px] text-muted-foreground">
                {customStatus}
              </p>
            ) : null}
          </div>
        </button>
      </UserInteractiveShell>
    </li>
  )
}

function MemberListSectionBlock({
  section,
  serverId,
  serverName,
  server,
  userIdsInVoice,
}: {
  section: MemberListSection
  serverId: string
  serverName?: string
  server: Server | undefined
  userIdsInVoice: Set<string>
}) {
  const isOffline = section.type === 'offline'

  return (
    <>
      {section.type === 'role' ? (
        <MemberListSectionHeader
          title={section.role.name}
          count={section.members.length}
        />
      ) : null}
      {section.type === 'offline' ? (
        <MemberListSectionHeader
          title="Не в сети"
          count={section.members.length}
        />
      ) : null}
      {section.members.map((entry) => (
        <MemberSidebarRow
          key={entry.user._id}
          entry={entry}
          server={server}
          serverId={serverId}
          serverName={serverName}
          nameColour={memberDisplayColour(server, entry.member)}
          dimmed={isOffline}
          showStatus={!isOffline}
          inVoice={userIdsInVoice.has(entry.user._id)}
        />
      ))}
    </>
  )
}

export function ChannelMemberSidebar({ channel }: ChannelMemberSidebarProps) {
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

  const sections = useMemo(
    () => groupServerMembersForSidebar(server, members),
    [members, server],
  )

  return (
    <aside className="hidden min-h-0 w-52 shrink-0 flex-col border-l border-shell-divider bg-card text-card-foreground lg:flex">
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-0.5 p-2">
          {sections.map((section, index) => (
            <MemberListSectionBlock
              key={
                section.type === 'role'
                  ? section.role.id
                  : `${section.type}-${index}`
              }
              section={section}
              serverId={channel.server}
              serverName={server?.name}
              server={server}
              userIdsInVoice={userIdsInVoice}
            />
          ))}
          {members.length === 0 ? (
            <li className="px-2 py-4 text-center text-xs text-muted-foreground">
              Нет участников
            </li>
          ) : null}
        </ul>
      </ScrollArea>
    </aside>
  )
}
