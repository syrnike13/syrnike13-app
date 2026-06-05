import type { Channel } from '@syrnike13/api-types'

import { UserAvatar } from '#/components/user/user-avatar'
import { UserInteractiveShell } from '#/components/user/user-interactive-shell'
import { ScrollArea } from '#/components/ui/scroll-area'
import { Badge } from '#/components/ui/badge'
import {
  listServerMembers,
  memberRoleEntries,
  memberRoleNames,
} from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { presenceLabel } from '#/lib/presence'

type ChannelMemberSidebarProps = {
  channel: Extract<Channel, { channel_type: 'TextChannel' | 'VoiceChannel' }>
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
  return (
    <aside className="hidden min-h-0 w-52 shrink-0 flex-col border-l border-shell-divider bg-card text-card-foreground lg:flex">
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-0.5 p-2">
          {members.map(({ member, user }) => {
            const roles = memberRoleNames(server, member)

            return (
              <li key={user._id}>
                <UserInteractiveShell
                  user={user}
                  serverId={channel.server}
                  serverName={server?.name}
                  roles={memberRoleEntries(server, member)}
                  side="left"
                  align="start"
                  inVoice={userIdsInVoice.has(user._id)}
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none data-[state=open]:bg-accent"
                  >
                    <UserAvatar user={user} className="size-8" showPresence />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {user.display_name ?? user.username}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {presenceLabel(user)}
                      </p>
                      {roles.length > 0 ? (
                        <div className="mt-1 flex flex-wrap gap-0.5">
                          {roles.slice(0, 2).map((role) => (
                            <Badge
                              key={role}
                              variant="secondary"
                              className="h-4 px-1 text-[9px]"
                            >
                              {role}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </button>
                </UserInteractiveShell>
              </li>
            )
          })}
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
