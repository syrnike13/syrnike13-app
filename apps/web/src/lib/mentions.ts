import type { Channel, Member, Message, User } from '@syrnike13/api-types'

import { isMemberSidebarOnline } from '#/features/sync/member-list-groups'

const ULID_PATTERN = '[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}'

/** User, role, and channel tokens embedded in message content. */
const MESSAGE_ENTITY_RE = new RegExp(
  `<([@%#])(${ULID_PATTERN})>`,
  'g',
)

const MENTION_INPUT_RE = /@([\w.-]*)$/

export function extractMentionQuery(value: string, caret: number) {
  const before = value.slice(0, caret)
  const match = before.match(MENTION_INPUT_RE)
  if (!match) return null
  return {
    query: match[1].toLowerCase(),
    start: caret - match[0].length,
  }
}

export function insertMention(
  value: string,
  start: number,
  caret: number,
  userId: string,
) {
  const mention = `<@${userId}> `
  return {
    value: value.slice(0, start) + mention + value.slice(caret),
    caret: start + mention.length,
  }
}

export function getMentionableUsers(
  channel: Channel | undefined,
  users: Record<string, User>,
  members: Record<string, import('@syrnike13/api-types').Member>,
  currentUserId?: string,
): User[] {
  if (!channel) return []

  let ids: string[] = []

  if (channel.channel_type === 'DirectMessage') {
    ids = channel.recipients
  } else if (channel.channel_type === 'Group') {
    ids = channel.recipients
  } else if (channel.channel_type === 'TextChannel') {
    ids = Object.values(members)
      .filter((member) => member._id.server === channel.server)
      .map((member) => member._id.user)
  }

  return ids
    .filter((id) => id !== currentUserId)
    .map((id) => users[id])
    .filter((user): user is User => Boolean(user))
    .sort((a, b) => a.username.localeCompare(b.username))
}

export function filterUsersByQuery(users: User[], query: string) {
  if (!query) return users.slice(0, 8)
  return users
    .filter(
      (user) =>
        user.username.toLowerCase().includes(query) ||
        user.display_name?.toLowerCase().includes(query),
    )
    .slice(0, 8)
}

/** MessageFlags bit indices (backend `MessageFlags`). */
const MESSAGE_FLAG_MENTIONS_EVERYONE = 2
const MESSAGE_FLAG_MENTIONS_ONLINE = 3

function messageHasFlag(flags: number | undefined, bit: number) {
  if (!flags) return false
  return (flags & (1 << bit)) !== 0
}

export function isMessageMentioningUser(
  message: Message,
  currentUserId: string | undefined,
  context?: {
    member?: Member
    currentUser?: User
  },
): boolean {
  if (!currentUserId || message.author === currentUserId) return false

  if (message.mentions?.includes(currentUserId)) return true

  if (message.role_mentions?.length && context?.member?.roles?.length) {
    const roleSet = new Set(message.role_mentions)
    if (context.member.roles.some((roleId) => roleSet.has(roleId))) {
      return true
    }
  }

  const flags = message.flags ?? 0
  if (messageHasFlag(flags, MESSAGE_FLAG_MENTIONS_EVERYONE)) return true

  if (
    messageHasFlag(flags, MESSAGE_FLAG_MENTIONS_ONLINE) &&
    context?.currentUser &&
    isMemberSidebarOnline(context.currentUser)
  ) {
    return true
  }

  if (message.content?.includes(`<@${currentUserId}>`)) return true

  return false
}

export { MESSAGE_ENTITY_RE }
