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
import {
  isIncomingVoiceCall,
  isVoiceCallDismissed,
  isVoiceCallRingingDismissed,
} from './voice-call-utils'
import { isServerVoiceChannel } from '#/lib/channel-voice'
import { canViewChannel } from '#/lib/permissions'
import type { ChannelUnreadState, SyncState } from './types'

export const EMPTY_CHANNELS: Channel[] = []
export const EMPTY_MESSAGES: Message[] = []
export const EMPTY_TYPING_USERS: string[] = []

export function listServers(state: SyncState): Server[] {
  return Object.values(state.servers).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
}

function hasBotRecipient(state: SyncState, channel: Channel) {
  if (
    channel.channel_type !== 'DirectMessage' &&
    channel.channel_type !== 'Group'
  ) {
    return false
  }

  return channel.recipients.some((recipientId) =>
    Boolean(state.users[recipientId]?.bot),
  )
}

export function listDmChannels(state: SyncState, currentUserId?: string) {
  return Object.values(state.channels)
    .filter(isDmChannel)
    .filter(isTextChannel)
    .filter((channel) => !hasBotRecipient(state, channel))
    .sort((a, b) =>
      getChannelLabel(a, state.users, currentUserId).localeCompare(
        getChannelLabel(b, state.users, currentUserId),
      ),
    )
}

export function findDirectMessageChannelWithUser(
  state: SyncState,
  currentUserId: string | undefined,
  userId: string | undefined,
) {
  if (!currentUserId || !userId || currentUserId === userId) return undefined
  if (state.users[userId]?.bot) return undefined

  return Object.values(state.channels).find(
    (channel) =>
      channel.channel_type === 'DirectMessage' &&
      channel.recipients.includes(currentUserId) &&
      channel.recipients.includes(userId),
  )
}

export function selectDirectMessageCallActionLabel(
  state: SyncState,
  currentUserId: string | undefined,
  userId: string | undefined,
) {
  const channel = findDirectMessageChannelWithUser(
    state,
    currentUserId,
    userId,
  )
  const call = channel ? state.voiceCalls[channel._id] : undefined
  if (!call) return 'Позвонить'
  if (
    !isVoiceCallRingingDismissed(call, state.dismissedVoiceCallKeys) &&
    isIncomingVoiceCall(call, currentUserId)
  ) {
    return 'Ответить'
  }

  return 'Присоединиться'
}

function isCurrentUserInChannelVoice(
  state: SyncState,
  channelId: string,
  currentUserId?: string,
) {
  return Boolean(
    currentUserId && state.voiceParticipants[channelId]?.[currentUserId],
  )
}

function hasIncomingVoiceCall(
  state: SyncState,
  channelId: string,
  currentUserId?: string,
) {
  const call = state.voiceCalls[channelId]
  if (isVoiceCallDismissed(call, state.dismissedVoiceCallKeys)) {
    return false
  }
  if (call?.phase === 'active') return true
  if (isVoiceCallRingingDismissed(call, state.dismissedVoiceCallKeys)) {
    return false
  }

  return isIncomingVoiceCall(call, currentUserId)
}

export function shouldShowDmChannelInRail(
  state: SyncState,
  channel: Channel,
  currentUserId?: string,
) {
  return (
    isChannelUnread(channel, state.unreads[channel._id]) ||
    isCurrentUserInChannelVoice(state, channel._id, currentUserId) ||
    hasIncomingVoiceCall(state, channel._id, currentUserId)
  )
}

export function listVisibleDmRailChannels(
  state: SyncState,
  currentUserId?: string,
) {
  return listDmChannels(state, currentUserId).filter((channel) =>
    shouldShowDmChannelInRail(state, channel, currentUserId),
  )
}

export function listServerTextChannelIds(
  state: SyncState,
  serverId: string,
  userId?: string,
): string[] {
  return listServerChannels(state, serverId, userId)
    .filter((channel) => channel.channel_type === 'TextChannel')
    .map((channel) => channel._id)
}

const serverChannelsListCache = new Map<
  string,
  {
    server: Server | undefined
    channels: SyncState['channels']
    userId: string | undefined
    list: Channel[]
  }
>()

export function listServerChannels(
  state: SyncState,
  serverId: string,
  userId?: string,
): Channel[] {
  const server = state.servers[serverId]
  const cached = serverChannelsListCache.get(serverId)
  if (
    cached &&
    cached.server === server &&
    cached.channels === state.channels &&
    cached.userId === userId
  ) {
    return cached.list
  }

  const channels = Object.values(state.channels).filter(
    (
      channel,
    ): channel is Extract<Channel, { channel_type: 'TextChannel' }> =>
      channel.channel_type === 'TextChannel' &&
      channel.server === serverId,
  )

  let list: Channel[]
  if (!server?.channels?.length) {
    list = channels.sort((a, b) => {
      const aVoice = isServerVoiceChannel(a)
      const bVoice = isServerVoiceChannel(b)
      if (aVoice !== bVoice) return aVoice ? 1 : -1
      return a.name.localeCompare(b.name)
    })
  } else {
    const order = new Map(server.channels.map((id, index) => [id, index]))
    list = channels.sort((a, b) => {
      const aVoice = isServerVoiceChannel(a)
      const bVoice = isServerVoiceChannel(b)
      if (aVoice !== bVoice) return aVoice ? 1 : -1
      const aIndex = order.get(a._id) ?? Number.MAX_SAFE_INTEGER
      const bIndex = order.get(b._id) ?? Number.MAX_SAFE_INTEGER
      if (aIndex !== bIndex) return aIndex - bIndex
      return a.name.localeCompare(b.name)
    })
  }

  if (userId && server) {
    const member = state.members[`${serverId}:${userId}`]
    list = list.filter((channel) =>
      canViewChannel(server, channel, member, userId),
    )
  }

  serverChannelsListCache.set(serverId, {
    server,
    channels: state.channels,
    userId,
    list,
  })
  return list
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
  unread: ChannelUnreadState | undefined,
): boolean {
  const lastMessageId = getChannelLastMessageId(channel)
  if (!lastMessageId) return false
  const lastReadId = unread?.lastId
  if (!lastReadId) return true
  return lastReadId.localeCompare(lastMessageId) < 0
}

export function channelUnreadMentionCount(
  unread: ChannelUnreadState | undefined,
) {
  return unread?.mentions.length ?? 0
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
    (a, b) =>
      (server.roles?.[a.id]?.rank ?? Number.MAX_SAFE_INTEGER) -
      (server.roles?.[b.id]?.rank ?? Number.MAX_SAFE_INTEGER),
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

export function listMutualServers(
  state: SyncState,
  userId: string,
  currentUserId: string | undefined,
): Server[] {
  if (!currentUserId || userId === currentUserId) return []

  const mutual: Server[] = []
  for (const server of Object.values(state.servers)) {
    if (
      state.members[`${server._id}:${userId}`] &&
      state.members[`${server._id}:${currentUserId}`]
    ) {
      mutual.push(server)
    }
  }

  return mutual.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}

export function listUserMutualServerNicknames(
  state: SyncState,
  userId: string,
  currentUserId: string | undefined,
): string[] {
  if (!currentUserId || userId === currentUserId) return []

  const user = state.users[userId]
  const globalNames = new Set(
    [user?.username, user?.display_name]
      .map((name) => name?.trim())
      .filter((name): name is string => Boolean(name)),
  )
  const seen = new Set<string>()
  const aliases: string[] = []

  for (const server of listMutualServers(state, userId, currentUserId)) {
    const nickname =
      state.members[`${server._id}:${userId}`]?.nickname?.trim()
    if (!nickname || globalNames.has(nickname) || seen.has(nickname)) continue

    seen.add(nickname)
    aliases.push(nickname)
  }

  return aliases
}

export function pickDefaultChannelId(
  state: SyncState,
  currentUserId?: string,
): string | undefined {
  const dm = listDmChannels(state, currentUserId)[0]
  if (dm) return dm._id

  const server = listServers(state)[0]
  if (!server) return undefined

  return listServerChannels(state, server._id, currentUserId)[0]?._id
}
