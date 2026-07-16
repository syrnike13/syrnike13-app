import type { Member, Server, User } from '@syrnike13/api-types'

import {
  MentionPill,
  defaultMentionClassName,
} from '#/components/chat/mention-pill'
import { UserProfilePopover } from '#/components/user/user-profile-popover'
import { memberDisplayColour } from '#/features/sync/member-list-groups'
import { memberRoleEntries } from '#/features/sync/selectors'

type MessageUserMentionProps = {
  userId: string
  user?: User
  server?: Server
  serverId?: string
  serverName?: string
  member?: Member
  currentUserId?: string
  interactive?: boolean
}

export function MessageUserMention({
  userId,
  user,
  server,
  serverId,
  serverName,
  member,
  currentUserId,
  interactive = true,
}: MessageUserMentionProps) {
  const label =
    member?.nickname?.trim() || user?.display_name || user?.username || userId
  const nameColour =
    server && member ? memberDisplayColour(server, member) : undefined

  if (!user) {
    return <span className={defaultMentionClassName}>@{userId}</span>
  }

  if (!interactive) {
    return <MentionPill label={`@${label}`} nameColour={nameColour} />
  }

  const roles =
    server && member ? memberRoleEntries(server, member) : undefined

  return (
    <UserProfilePopover
      user={user}
      serverId={serverId}
      serverName={serverName}
      roles={roles}
      hideMessage={user._id === currentUserId}
      side="right"
      align="start"
    >
      <button
        type="button"
        className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <MentionPill label={`@${label}`} nameColour={nameColour} />
      </button>
    </UserProfilePopover>
  )
}
