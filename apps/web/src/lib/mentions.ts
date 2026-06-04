import type { Channel, User } from '@syrnike13/api-types'

const MENTION_RE = /<@([0-9ABCDEFGHJKMNPQRSTVWXYZ]{26})>/g
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

export { MENTION_RE }
