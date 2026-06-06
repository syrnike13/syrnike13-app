import { useRef, useSyncExternalStore } from 'react'
import type {
  Channel,
  ChannelUnread,
  Emoji,
  Member,
  Message,
  Role,
  Server,
  User,
} from '@syrnike13/api-types'

import type { GatewayServerEvent, ReadyPayload, SyncState } from './types'
import type { UserVoiceState, VoiceParticipantsByChannel } from './voice-types'
import {
  mergeVoiceStatesFromReady,
  normalizeUserVoiceState,
} from './voice-event-utils'
import { isValidVoiceUserId } from './voice-participant-resolve'

function emptyState(): SyncState {
  return {
    ready: false,
    selectedServerId: null,
    servers: {},
    channels: {},
    users: {},
    members: {},
    emojis: {},
    messages: {},
    unreads: {},
    typingUsers: {},
    voiceParticipants: {},
  }
}

let state = emptyState()
const listeners = new Set<() => void>()
let batchDepth = 0
let batchHasChanges = false

function emit() {
  if (batchDepth > 0) {
    batchHasChanges = true
    return
  }
  listeners.forEach((listener) => listener())
}

function batchUpdates(run: () => void) {
  batchDepth += 1
  try {
    run()
  } finally {
    batchDepth -= 1
    if (batchDepth === 0 && batchHasChanges) {
      batchHasChanges = false
      listeners.forEach((listener) => listener())
    }
  }
}

function setState(patch: Partial<SyncState>) {
  const next = { ...state, ...patch }
  if (
    Object.keys(patch).every(
      (key) =>
        state[key as keyof SyncState] === next[key as keyof SyncState],
    )
  ) {
    return
  }
  state = next
  emit()
}

function upsertRecord<T extends { _id: string }>(
  record: Record<string, T>,
  items: T[] | undefined,
) {
  if (!items?.length) return record
  const next = { ...record }
  for (const item of items) {
    next[item._id] = item
  }
  return next
}

function mergeChannel(existing: Channel | undefined, patch: Partial<Channel>) {
  if (!existing) return patch as Channel
  return { ...existing, ...patch } as Channel
}

function memberKey(member: Member) {
  return `${member._id.server}:${member._id.user}`
}

function cloneReactions(reactions: Message['reactions']) {
  if (!reactions) return {} as Record<string, string[]>
  return Object.fromEntries(
    Object.entries(reactions).map(([emoji, userIds]) => [emoji, [...userIds]]),
  )
}

function userCanAppearInMultipleVoiceChannels(userId: string) {
  return Boolean(state.users[userId]?.bot)
}

function removeVoiceParticipantFromOtherChannels(
  voiceParticipants: VoiceParticipantsByChannel,
  userId: string,
  targetChannelId: string,
) {
  let changed = false
  for (const channelId of Object.keys(voiceParticipants)) {
    if (channelId === targetChannelId) continue
    if (!voiceParticipants[channelId]?.[userId]) continue

    changed = true
    const { [userId]: _, ...channelMap } = voiceParticipants[channelId]
    if (Object.keys(channelMap).length === 0) {
      delete voiceParticipants[channelId]
    } else {
      voiceParticipants[channelId] = channelMap
    }
  }
  return changed
}

function voiceStateEquals(
  left: UserVoiceState | undefined,
  right: UserVoiceState | undefined,
) {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.id === right.id &&
    left.joined_at === right.joined_at &&
    left.is_publishing === right.is_publishing &&
    left.is_receiving === right.is_receiving &&
    left.server_muted === right.server_muted &&
    left.server_deafened === right.server_deafened &&
    left.camera === right.camera &&
    left.screensharing === right.screensharing
  )
}

function voiceChannelMapEquals(
  left: Record<string, UserVoiceState> | undefined,
  right: Record<string, UserVoiceState>,
) {
  const leftKeys = Object.keys(left ?? {})
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of rightKeys) {
    if (!voiceStateEquals(left?.[key], right[key])) return false
  }
  return true
}

export const syncStore = {
  getState: () => state,

  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  reset() {
    state = emptyState()
    emit()
  },

  setSelectedServerId(serverId: string | null) {
    const prev = state.selectedServerId
    if (prev === serverId) return
    setState({ selectedServerId: serverId })
  },

  applyReady(payload: ReadyPayload) {
    const servers = upsertRecord(state.servers, payload.servers)
    const channels = upsertRecord(state.channels, payload.channels)
    const users = upsertRecord(state.users, payload.users)
    const membersMap = { ...state.members }
    for (const member of payload.members ?? []) {
      membersMap[memberKey(member)] = member
    }
    const emojis = upsertRecord(state.emojis, payload.emojis)
    const unreads = { ...state.unreads }

    for (const unread of payload.channel_unreads ?? []) {
      unreads[unread._id.channel] = unread.last_id ?? null
    }

    const firstServerId = payload.servers?.[0]?._id ?? state.selectedServerId
    const voiceParticipants = mergeVoiceStatesFromReady(
      state.voiceParticipants,
      payload.voice_states,
    )

    setState({
      ready: true,
      servers,
      channels,
      users,
      members: membersMap,
      emojis,
      unreads,
      voiceParticipants,
      selectedServerId:
        state.selectedServerId ?? firstServerId ?? null,
    })
  },

  setChannelVoiceParticipants(
    channelId: string,
    participants: UserVoiceState[],
  ) {
    const channelMap: Record<string, UserVoiceState> = {}
    const voiceParticipants = { ...state.voiceParticipants }
    let removedFromOtherChannel = false
    for (const participant of participants) {
      if (!isValidVoiceUserId(participant.id)) continue
      if (!userCanAppearInMultipleVoiceChannels(participant.id)) {
        removedFromOtherChannel =
          removeVoiceParticipantFromOtherChannels(
            voiceParticipants,
            participant.id,
            channelId,
          ) || removedFromOtherChannel
      }
      channelMap[participant.id] = participant
    }
    if (
      !removedFromOtherChannel &&
      voiceChannelMapEquals(state.voiceParticipants[channelId], channelMap)
    ) {
      return
    }
    if (Object.keys(channelMap).length === 0) {
      delete voiceParticipants[channelId]
    } else {
      voiceParticipants[channelId] = channelMap
    }
    setState({
      voiceParticipants,
    })
  },

  addVoiceParticipant(channelId: string, participant: UserVoiceState) {
    if (!isValidVoiceUserId(participant.id)) return
    const existing = state.voiceParticipants[channelId]?.[participant.id]
    if (voiceStateEquals(existing, participant)) return
    const voiceParticipants = { ...state.voiceParticipants }
    if (!userCanAppearInMultipleVoiceChannels(participant.id)) {
      removeVoiceParticipantFromOtherChannels(
        voiceParticipants,
        participant.id,
        channelId,
      )
    }
    const channelMap = {
      ...(voiceParticipants[channelId] ?? {}),
      [participant.id]: participant,
    }
    setState({
      voiceParticipants: {
        ...voiceParticipants,
        [channelId]: channelMap,
      },
    })
  },

  removeVoiceParticipant(channelId: string, userId: string) {
    const existing = state.voiceParticipants[channelId]
    if (!existing?.[userId]) return
    const { [userId]: _, ...channelMap } = existing
    const voiceParticipants = { ...state.voiceParticipants }
    if (Object.keys(channelMap).length === 0) {
      delete voiceParticipants[channelId]
    } else {
      voiceParticipants[channelId] = channelMap
    }
    setState({ voiceParticipants })
  },

  removeVoiceParticipantFromAllChannels(userId: string) {
    if (!isValidVoiceUserId(userId)) return
    let changed = false
    const voiceParticipants = { ...state.voiceParticipants }
    for (const channelId of Object.keys(voiceParticipants)) {
      if (!voiceParticipants[channelId]?.[userId]) continue
      changed = true
      const { [userId]: _, ...channelMap } = voiceParticipants[channelId]
      if (Object.keys(channelMap).length === 0) {
        delete voiceParticipants[channelId]
      } else {
        voiceParticipants[channelId] = channelMap
      }
    }
    if (changed) setState({ voiceParticipants })
  },

  pruneUnknownVoiceParticipants(currentUserId?: string) {
    let changed = false
    const voiceParticipants = { ...state.voiceParticipants }
    for (const channelId of Object.keys(voiceParticipants)) {
      const channelMap = { ...voiceParticipants[channelId] }
      for (const userId of Object.keys(channelMap)) {
        const known =
          (currentUserId && userId === currentUserId) ||
          Boolean(state.users[userId])
        if (!isValidVoiceUserId(userId) || !known) {
          delete channelMap[userId]
          changed = true
        }
      }
      if (Object.keys(channelMap).length === 0) {
        delete voiceParticipants[channelId]
      } else {
        voiceParticipants[channelId] = channelMap
      }
    }
    if (changed) setState({ voiceParticipants })
  },

  patchVoiceParticipant(
    channelId: string,
    userId: string,
    patch: Partial<UserVoiceState>,
  ) {
    const existing = state.voiceParticipants[channelId]?.[userId]
    const normalized = normalizeUserVoiceState(
      existing
        ? { ...existing, ...patch, id: userId }
        : { id: userId, ...patch },
    )
    if (!normalized) return
    this.addVoiceParticipant(channelId, normalized)
  },

  moveVoiceParticipant(
    userId: string,
    fromChannelId: string,
    toChannelId: string,
    participant: UserVoiceState,
  ) {
    const voiceParticipants = { ...state.voiceParticipants }
    if (!userCanAppearInMultipleVoiceChannels(userId)) {
      removeVoiceParticipantFromOtherChannels(
        voiceParticipants,
        userId,
        toChannelId,
      )
    }
    const fromMap = { ...(voiceParticipants[fromChannelId] ?? {}) }
    delete fromMap[userId]
    if (Object.keys(fromMap).length === 0) {
      delete voiceParticipants[fromChannelId]
    } else {
      voiceParticipants[fromChannelId] = fromMap
    }
    voiceParticipants[toChannelId] = {
      ...(voiceParticipants[toChannelId] ?? {}),
      [userId]: participant,
    }
    setState({ voiceParticipants })
  },

  upsertEmoji(emoji: Emoji) {
    setState({
      emojis: { ...state.emojis, [emoji._id]: emoji },
    })
  },

  removeEmoji(emojiId: string) {
    const { [emojiId]: _, ...emojis } = state.emojis
    setState({ emojis })
  },

  setUnreads(unreadsList: ChannelUnread[]) {
    const unreads = { ...state.unreads }
    let changed = false
    for (const unread of unreadsList) {
      const channelId = unread._id.channel
      const lastId = unread.last_id ?? null
      if (unreads[channelId] !== lastId) {
        unreads[channelId] = lastId
        changed = true
      }
    }
    if (changed) setState({ unreads })
  },

  setChannelLastRead(channelId: string, messageId: string | null) {
    if (state.unreads[channelId] === messageId) return
    setState({
      unreads: { ...state.unreads, [channelId]: messageId },
    })
  },

  /** Локально снять непрочитанное со всех каналов сервера. */
  markServerChannelsRead(serverId: string) {
    const unreads = { ...state.unreads }
    let changed = false
    for (const channel of Object.values(state.channels)) {
      if (
        (channel.channel_type === 'TextChannel' ||
          channel.channel_type === 'VoiceChannel') &&
        channel.server === serverId &&
        'last_message_id' in channel &&
        channel.last_message_id &&
        unreads[channel._id] !== channel.last_message_id
      ) {
        unreads[channel._id] = channel.last_message_id
        changed = true
      }
    }
    if (changed) setState({ unreads })
  },

  setUserTyping(channelId: string, userId: string, isTyping: boolean) {
    const current = state.typingUsers[channelId] ?? []
    const hasUser = current.includes(userId)

    if (isTyping && hasUser) return
    if (!isTyping && !hasUser) return

    const next = isTyping
      ? [...current, userId]
      : current.filter((id) => id !== userId)

    setState({
      typingUsers: { ...state.typingUsers, [channelId]: next },
    })
  },

  upsertUser(user: User) {
    const existing = state.users[user._id]
    if (existing === user) return
    setState({
      users: { ...state.users, [user._id]: user },
    })
  },

  upsertUsers(users: User[]) {
    if (!users.length) return
    let nextUsers: Record<string, User> | null = null
    for (const user of users) {
      const existing = state.users[user._id]
      if (existing === user) continue
      if (!nextUsers) nextUsers = { ...state.users }
      nextUsers[user._id] = user
    }
    if (nextUsers) setState({ users: nextUsers })
  },

  upsertMembers(members: Member[]) {
    if (!members.length) return
    let next: Record<string, Member> | null = null
    for (const member of members) {
      const key = memberKey(member)
      if (state.members[key] === member) continue
      if (!next) next = { ...state.members }
      next[key] = member
    }
    if (next) setState({ members: next })
  },

  upsertMembersAndUsers(members: Member[], users: User[]) {
    if (!members.length && !users.length) return

    let nextMembers: Record<string, Member> | null = null
    for (const member of members) {
      const key = memberKey(member)
      if (state.members[key] === member) continue
      if (!nextMembers) nextMembers = { ...state.members }
      nextMembers[key] = member
    }

    let nextUsers: Record<string, User> | null = null
    for (const user of users) {
      const existing = state.users[user._id]
      if (existing === user) continue
      if (!nextUsers) nextUsers = { ...state.users }
      nextUsers[user._id] = user
    }

    if (!nextMembers && !nextUsers) return
    setState({
      members: nextMembers ?? state.members,
      users: nextUsers ?? state.users,
    })
  },

  removeServerMember(serverId: string, userId: string) {
    const key = `${serverId}:${userId}`
    if (!state.members[key]) return
    const { [key]: _, ...members } = state.members
    setState({ members })
  },

  prependChannelMessages(channelId: string, messages: Message[]) {
    if (!messages.length) return
    const channelMessages = { ...(state.messages[channelId] ?? {}) }
    for (const message of messages) {
      channelMessages[message._id] = message
    }
    setState({
      messages: {
        ...state.messages,
        [channelId]: channelMessages,
      },
    })
  },

  upsertServer(server: Server) {
    setState({
      servers: { ...state.servers, [server._id]: server },
    })
  },

  removeServer(serverId: string) {
    const { [serverId]: _, ...servers } = state.servers
    const channels = { ...state.channels }
    for (const [id, channel] of Object.entries(channels)) {
      if (
        (channel.channel_type === 'TextChannel' ||
          channel.channel_type === 'VoiceChannel') &&
        channel.server === serverId
      ) {
        delete channels[id]
      }
    }
    setState({ servers, channels })
  },

  upsertChannel(channel: Channel) {
    setState({
      channels: { ...state.channels, [channel._id]: channel },
    })
  },

  patchChannel(channelId: string, data: Partial<Channel>) {
    const existing = state.channels[channelId]
    if (!existing) return
    setState({
      channels: {
        ...state.channels,
        [channelId]: mergeChannel(existing, data),
      },
    })
  },

  removeChannel(channelId: string) {
    const { [channelId]: _, ...channels } = state.channels
    const { [channelId]: __, ...messages } = state.messages
    setState({ channels, messages })
  },

  upsertMessage(message: Message) {
    const channelMessages = state.messages[message.channel] ?? {}
    const existing = channelMessages[message._id]
    const channel = state.channels[message.channel]
    const needsLastMessageBump =
      channel &&
      'last_message_id' in channel &&
      channel.last_message_id !== message._id

    if (existing === message && !needsLastMessageBump) return

    const channels = needsLastMessageBump
      ? {
          ...state.channels,
          [message.channel]: {
            ...channel,
            last_message_id: message._id,
          },
        }
      : state.channels

    const nextChannelMessages =
      existing === message
        ? channelMessages
        : { ...channelMessages, [message._id]: message }

    if (channels === state.channels && nextChannelMessages === channelMessages) {
      return
    }

    setState({
      channels,
      messages: {
        ...state.messages,
        [message.channel]: nextChannelMessages,
      },
    })
  },

  patchMessage(channelId: string, messageId: string, data: Partial<Message>) {
    const channelMessages = state.messages[channelId]
    const existing = channelMessages?.[messageId]
    if (!existing) return
    setState({
      messages: {
        ...state.messages,
        [channelId]: {
          ...channelMessages,
          [messageId]: { ...existing, ...data },
        },
      },
    })
  },

  removeMessage(channelId: string, messageId: string) {
    const channelMessages = state.messages[channelId]
    if (!channelMessages) return
    const { [messageId]: _, ...rest } = channelMessages
    setState({
      messages: {
        ...state.messages,
        [channelId]: rest,
      },
    })
  },

  mutateReaction(
    channelId: string,
    messageId: string,
    emojiId: string,
    userId: string,
    add: boolean,
  ) {
    const existing = state.messages[channelId]?.[messageId]
    if (!existing) return

    const reactions = cloneReactions(existing.reactions)
    const current = new Set(reactions[emojiId] ?? [])

    if (add) {
      current.add(userId)
    } else {
      current.delete(userId)
      if (current.size === 0) {
        delete reactions[emojiId]
      }
    }

    if (current.size > 0) {
      reactions[emojiId] = [...current]
    }

    this.patchMessage(channelId, messageId, { reactions })
  },

  setChannelMessages(channelId: string, messages: Message[]) {
    const existing = state.messages[channelId]
    if (existing && messages.length > 0) {
      let unchanged = Object.keys(existing).length === messages.length
      if (unchanged) {
        for (const message of messages) {
          if (existing[message._id] !== message) {
            unchanged = false
            break
          }
        }
      }
      if (unchanged) return
    }

    const map: Record<string, Message> = {}
    for (const message of messages) {
      map[message._id] = message
    }
    setState({
      messages: {
        ...state.messages,
        [channelId]: map,
      },
    })
  },

  handleGatewayEvent(event: GatewayServerEvent) {
    switch (event.type) {
      case 'Bulk': {
        const items = event.v as GatewayServerEvent[] | undefined
        if (items?.length) {
          batchUpdates(() => {
            items.forEach((item) => this.handleGatewayEvent(item))
          })
        }
        break
      }
      case 'Ready': {
        const {
          users,
          servers,
          channels,
          members,
          emojis,
          channel_unreads,
          voice_states,
        } = event as ReadyPayload & { type: string }
        this.applyReady({
          users,
          servers,
          channels,
          members,
          emojis,
          channel_unreads,
          voice_states,
        })
        break
      }
      case 'VoiceChannelJoin': {
        /** Voice state v1: `id` — канал, `state` — UserVoiceState (state.id — user). */
        const payload = event as {
          id: string
          channel?: string
          channel_id?: string
          state?: UserVoiceState & { user?: string; user_id?: string }
        }
        const channelId =
          payload.channel ?? payload.channel_id ?? payload.id
        const voiceState = normalizeUserVoiceState(payload.state ?? {})
        if (channelId && voiceState) {
          this.addVoiceParticipant(channelId, voiceState)
        }
        break
      }
      case 'VoiceChannelLeave': {
        /** Voice state v1: `id` — канал, `user` — кто вышел. */
        const payload = event as {
          id: string
          user: string
          channel?: string
          channel_id?: string
          user_id?: string
        }
        const channelId =
          payload.channel ?? payload.channel_id ?? payload.id
        const userId = payload.user ?? payload.user_id
        if (channelId && userId) {
          this.removeVoiceParticipant(channelId, userId)
        }
        break
      }
      case 'VoiceChannelMove': {
        const payload = event as {
          user: string
          from: string
          to: string
          state: UserVoiceState & { user?: string; user_id?: string }
        }
        const voiceState = normalizeUserVoiceState(payload.state)
        if (voiceState) {
          this.moveVoiceParticipant(
            payload.user,
            payload.from,
            payload.to,
            voiceState,
          )
        }
        break
      }
      case 'UserVoiceStateUpdate': {
        const { id, channel_id, data } = event as {
          id: string
          channel_id: string
          data: Partial<UserVoiceState>
        }
        this.patchVoiceParticipant(channel_id, id, data)
        break
      }
      case 'MessageReact': {
        const { id, channel_id, user_id, emoji_id } = event as {
          id: string
          channel_id: string
          user_id: string
          emoji_id: string
        }
        this.mutateReaction(channel_id, id, emoji_id, user_id, true)
        break
      }
      case 'MessageUnreact': {
        const { id, channel_id, user_id, emoji_id } = event as {
          id: string
          channel_id: string
          user_id: string
          emoji_id: string
        }
        this.mutateReaction(channel_id, id, emoji_id, user_id, false)
        break
      }
      case 'MessageRemoveReaction': {
        const { id, channel_id, emoji_id } = event as {
          id: string
          channel_id: string
          emoji_id: string
        }
        const existing = state.messages[channel_id]?.[id]
        if (!existing) break
        const reactions = cloneReactions(existing.reactions)
        delete reactions[emoji_id]
        this.patchMessage(channel_id, id, { reactions })
        break
      }
      case 'ChannelStartTyping': {
        const { id, user } = event as { id: string; user: string }
        this.setUserTyping(id, user, true)
        break
      }
      case 'ChannelStopTyping': {
        const { id, user } = event as { id: string; user: string }
        this.setUserTyping(id, user, false)
        break
      }
      case 'ChannelAck': {
        const { id, message_id } = event as {
          id: string
          message_id: string
        }
        this.setChannelLastRead(id, message_id)
        break
      }
      case 'Message':
        this.upsertMessage(event as Message)
        break
      case 'MessageUpdate': {
        const { channel, id, data } = event as {
          channel: string
          id: string
          data: Partial<Message>
        }
        this.patchMessage(channel, id, data)
        break
      }
      case 'MessageDelete': {
        const { channel, id } = event as { channel: string; id: string }
        this.removeMessage(channel, id)
        break
      }
      case 'BulkMessageDelete': {
        const { channel, ids } = event as { channel: string; ids: string[] }
        batchUpdates(() => {
          for (const id of ids) this.removeMessage(channel, id)
        })
        break
      }
      case 'ChannelCreate':
        this.upsertChannel(event as Channel)
        break
      case 'ChannelUpdate': {
        const { id, data } = event as { id: string; data: Partial<Channel> }
        this.patchChannel(id, data)
        break
      }
      case 'ChannelDelete': {
        const { id } = event as { id: string }
        this.removeChannel(id)
        break
      }
      case 'ServerCreate': {
        const payload = event as {
          server?: Server
          channels?: Channel[]
          id?: string
        }
        batchUpdates(() => {
          if (payload.server) {
            this.upsertServer(payload.server)
          }
          for (const channel of payload.channels ?? []) {
            this.upsertChannel(channel)
          }
        })
        break
      }
      case 'ServerUpdate': {
        const { id, data } = event as { id: string; data: Partial<Server> }
        const existing = state.servers[id]
        if (existing) {
          this.upsertServer({ ...existing, ...data })
        }
        break
      }
      case 'ServerDelete': {
        const { id } = event as { id: string }
        this.removeServer(id)
        break
      }
      case 'ServerRoleUpdate': {
        const { id, role_id, data } = event as {
          id: string
          role_id: string
          data: Record<string, unknown>
        }
        const server = state.servers[id]
        if (!server) break
        const existing = server.roles?.[role_id]
        const roles = {
          ...server.roles,
          [role_id]: existing
            ? { ...existing, ...data }
            : ({ _id: role_id, ...data } as Role),
        }
        this.upsertServer({ ...server, roles })
        break
      }
      case 'ServerRoleRanksUpdate': {
        const { id, ranks } = event as { id: string; ranks: string[] }
        const server = state.servers[id]
        if (!server?.roles) break
        const roles = { ...server.roles }
        for (const [rank, roleId] of ranks.entries()) {
          const role = roles[roleId]
          if (!role) continue
          roles[roleId] = { ...role, rank }
        }
        this.upsertServer({ ...server, roles })
        break
      }
      case 'ServerRoleDelete': {
        const { id, role_id } = event as { id: string; role_id: string }
        const server = state.servers[id]
        if (!server?.roles) break
        const { [role_id]: _, ...roles } = server.roles
        this.upsertServer({ ...server, roles })
        break
      }
      case 'UserUpdate': {
        const { id, data } = event as { id: string; data: Partial<User> }
        const existing = state.users[id]
        if (existing) {
          this.upsertUser({ ...existing, ...data })
        }
        break
      }
      case 'UserRelationship': {
        const { user } = event as { user: User }
        this.upsertUser(user)
        break
      }
      case 'UserPresence': {
        const { id, online } = event as { id: string; online: boolean }
        const existing = state.users[id]
        if (existing) {
          this.upsertUser({ ...existing, online })
        }
        break
      }
      case 'EmojiCreate':
        this.upsertEmoji(event as Emoji)
        break
      case 'EmojiDelete': {
        const { id } = event as { id: string }
        this.removeEmoji(id)
        break
      }
      case 'ServerMemberUpdate': {
        const { id, data, clear } = event as {
          id: { server: string; user: string }
          data: Partial<Member>
          clear?: string[]
        }
        const key = `${id.server}:${id.user}`
        const existing = state.members[key]
        if (!existing) break

        let member: Member = {
          ...existing,
          ...data,
          _id: existing._id,
        }

        for (const field of clear ?? []) {
          switch (field) {
            case 'Roles':
              member = { ...member, roles: [] }
              break
            case 'Nickname':
              member = { ...member, nickname: undefined }
              break
            case 'Avatar':
              member = { ...member, avatar: undefined }
              break
            case 'Timeout':
              member = { ...member, timeout: undefined }
              break
            case 'CanReceive':
              member = { ...member, can_receive: true }
              break
            case 'CanPublish':
              member = { ...member, can_publish: true }
              break
            default:
              break
          }
        }

        this.upsertMembers([member])
        break
      }
      case 'ServerMemberJoin': {
        const { id: serverId, user: userId } = event as {
          id: string
          user: string
        }
        const key = `${serverId}:${userId}`
        if (state.members[key]) break
        this.upsertMembers([
          {
            _id: { server: serverId, user: userId },
          } as Member,
        ])
        break
      }
      case 'ServerMemberLeave': {
        const { id: serverId, user: userId } = event as {
          id: string
          user: string
        }
        this.removeServerMember(serverId, userId)
        break
      }
      default:
        break
    }
  },
}

export function useSyncStore<T>(selector: (state: SyncState) => T): T {
  const selectorRef = useRef(selector)
  selectorRef.current = selector

  const cacheRef = useRef<{ store: SyncState; value: T } | null>(null)

  const getSnapshot = () => {
    const store = syncStore.getState()
    if (cacheRef.current?.store === store) {
      return cacheRef.current.value
    }
    const value = selectorRef.current(store)
    cacheRef.current = { store, value }
    return value
  }

  return useSyncExternalStore(
    (listener) => syncStore.subscribe(listener),
    getSnapshot,
    getSnapshot,
  )
}

export function useSyncReady() {
  return useSyncStore((s) => s.ready)
}
