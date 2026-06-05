import type {
  Channel,
  Emoji,
  Member,
  Message,
  RelationshipStatus,
  Server,
  User,
} from '@syrnike13/api-types'

import { getChannelLabel, isDmChannel, isTextChannel } from './channel-label'
import { isServerVoiceChannel } from '#/lib/channel-voice'
import type { SyncState } from './types'

export const EMPTY_CHANNELS: Channel[] = []
export const EMPTY_MESSAGES: Message[] = []
export const EMPTY_TYPING_USERS: string[] = []

export function listServers(state: SyncState): Server[] {
  return Object.values(state.servers).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
}

export function listDmChannels(state: SyncState, currentUserId?: string) {
  return Object.values(state.channels)
    .filter(isDmChannel)
    .filter(isTextChannel)
    .sort((a, b) =>
      getChannelLabel(a, state.users, currentUserId).localeCompare(
        getChannelLabel(b, state.users, currentUserId),
      ),
    )
}

export function listServerTextChannelIds(
  state: SyncState,
  serverId: string,
): string[] {
  return listServerChannels(state, serverId)
    .filter((channel) => channel.channel_type === 'TextChannel')
    .map((channel) => channel._id)
}

export function listServerChannels(
  state: SyncState,
  serverId: string,
): Channel[] {
  const server = state.servers[serverId]
  const channels = Object.values(state.channels).filter(
    (
      channel,
    ): channel is Extract<Channel, { channel_type: 'TextChannel' }> =>
      channel.channel_type === 'TextChannel' &&
      channel.server === serverId,
  )

  if (!server?.channels?.length) {
    return channels.sort((a, b) => {
      const aVoice = isServerVoiceChannel(a)
      const bVoice = isServerVoiceChannel(b)
      if (aVoice !== bVoice) return aVoice ? 1 : -1
      return a.name.localeCompare(b.name)
    })
  }

  const order = new Map(server.channels.map((id, index) => [id, index]))
  return channels.sort((a, b) => {
    const aVoice = isServerVoiceChannel(a)
    const bVoice = isServerVoiceChannel(b)
    if (aVoice !== bVoice) return aVoice ? 1 : -1
    const aIndex = order.get(a._id) ?? Number.MAX_SAFE_INTEGER
    const bIndex = order.get(b._id) ?? Number.MAX_SAFE_INTEGER
    if (aIndex !== bIndex) return aIndex - bIndex
    return a.name.localeCompare(b.name)
  })
}

const channelMessagesListCache = new Map<
  string,
  { map: Record<string, Message>; list: Message[] }
>()

export function getChannelMessages(state: SyncState, channelId: string) {
  const map = state.messages[channelId]
  if (!map) return EMPTY_MESSAGES
  const messages = Object.values(map)
  if (messages.length === 0) return EMPTY_MESSAGES

  const cached = channelMessagesListCache.get(channelId)
  if (cached && cached.map === map) {
    return cached.list
  }

  const list = [...messages].sort((a, b) => a._id.localeCompare(b._id))
  channelMessagesListCache.set(channelId, { map, list })
  return list
}

export function getChannelLastMessageId(channel: Channel): string | null {
  if ('last_message_id' in channel) {
    return channel.last_message_id ?? null
  }
  return null
}

export function isChannelUnread(
  channel: Channel,
  lastReadId: string | null | undefined,
): boolean {
  const lastMessageId = getChannelLastMessageId(channel)
  if (!lastMessageId) return false
  if (!lastReadId) return true
  return lastReadId.localeCompare(lastMessageId) < 0
}

function sortUsers(users: User[]) {
  return users.sort((a, b) =>
    (a.display_name ?? a.username).localeCompare(
      b.display_name ?? b.username,
    ),
  )
}

export function listUsersByRelationship(
  state: SyncState,
  relationship: RelationshipStatus,
  currentUserId?: string,
) {
  return sortUsers(
    Object.values(state.users).filter(
      (user) =>
        user.relationship === relationship && user._id !== currentUserId,
    ),
  )
}

export type ServerMemberEntry = {
  member: Member
  user: User
}

export function listServerCustomEmojis(
  state: SyncState,
  serverId: string,
): Emoji[] {
  return Object.values(state.emojis)
    .filter(
      (emoji) =>
        emoji.parent.type === 'Server' && emoji.parent.id === serverId,
    )
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function memberRoleNames(
  server: Server | undefined,
  member: Member,
): string[] {
  return memberRoleEntries(server, member).map((role) => role.name)
}

export type MemberRoleEntry = {
  id: string
  name: string
  colour: string | null
}

export function memberRoleEntries(
  server: Server | undefined,
  member: Member,
): MemberRoleEntry[] {
  if (!server?.roles || !member.roles?.length) return []

  const entries: MemberRoleEntry[] = []
  for (const roleId of member.roles) {
    const role = server.roles[roleId]
    if (!role) continue
    entries.push({
      id: role._id,
      name: role.name,
      colour: role.colour ?? null,
    })
  }

  return entries.sort(
    (a, b) => (server.roles?.[b.id]?.rank ?? 0) - (server.roles?.[a.id]?.rank ?? 0),
  )
}

const serverMembersListCache = new Map<
  string,
  {
    members: SyncState['members']
    users: SyncState['users']
    list: ServerMemberEntry[]
  }
>()

export function listServerMembers(
  state: SyncState,
  serverId: string,
): ServerMemberEntry[] {
  const cached = serverMembersListCache.get(serverId)
  if (
    cached &&
    cached.members === state.members &&
    cached.users === state.users
  ) {
    return cached.list
  }

  const entries: ServerMemberEntry[] = []

  for (const member of Object.values(state.members)) {
    if (member._id.server !== serverId) continue
    const user = state.users[member._id.user]
    if (!user) continue
    entries.push({ member, user })
  }

  const list = entries.sort((a, b) => {
    const aOnline = a.user.online ? 0 : 1
    const bOnline = b.user.online ? 0 : 1
    if (aOnline !== bOnline) return aOnline - bOnline
    return (a.user.display_name ?? a.user.username).localeCompare(
      b.user.display_name ?? b.user.username,
    )
  })

  serverMembersListCache.set(serverId, {
    members: state.members,
    users: state.users,
    list,
  })

  return list
}

export function pickDefaultChannelId(
  state: SyncState,
  currentUserId?: string,
): string | undefined {
  const dm = listDmChannels(state, currentUserId)[0]
  if (dm) return dm._id

  const server = listServers(state)[0]
  if (!server) return undefined

  return listServerChannels(state, server._id)[0]?._id
}
