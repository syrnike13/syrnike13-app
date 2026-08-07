import { useRef, useSyncExternalStore } from 'react'
import type {
  Channel,
  ChannelUnread,
  Emoji,
  FieldsChannel,
  InviteJoinResponse,
  Member,
  Message,
  Role,
  Server,
  User,
} from '@syrnike13/api-types'
import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Fiber, Option, Schema } from 'effect'

import type {
  GatewayServerEvent,
  GroupJoinBundle,
  ReadyPayload,
  ServerJoinBundle,
  ServerMemberUpdateEvent,
  ServerRoleUpdateEvent,
  ServerUpdateEvent,
  SyncState,
} from './types'
import type { UserVoiceState, VoiceParticipantsByChannel } from './voice-types'
import type { VoiceCallState } from './voice-types'
import {
  mergeVoiceStatesFromReady,
  normalizeUserVoiceState,
  shouldApplyVoiceState,
} from './voice-event-utils'
import { voiceCallUiKey } from './voice-call-utils'
import { isValidVoiceUserId } from './voice-participant-resolve'
import { serverChannelServerId } from '#/lib/channel-voice'

const ChannelSchema = Schema.declare<Channel>(
  (input): input is Channel => Schema.is(ApiSchema.Channel)(input),
)
const RoleSchema = Schema.declare<Role>(
  (input): input is Role => Schema.is(ApiSchema.Role)(input),
)
const MemberSchema = Schema.declare<Member>(
  (input): input is Member => Schema.is(ApiSchema.Member)(input),
)

function emptyState(): SyncState {
  return {
    ready: false,
    authorization: {
      revision: 0,
      global: 0,
      servers: {},
      channels: {},
      users: {},
    },
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
    voiceCalls: {},
    dismissedVoiceCallKeys: {},
  }
}

let state = emptyState()
let currentUserId: string | undefined
const listeners = new Set<() => void>()
const voiceCallExpiryTimers: Record<string, Fiber.Fiber<void, never>> = {}
const GROUP_UNANSWERED_ACTIVE_MS = 10 * 60 * 1000
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

function clearVoiceCallExpiryTimer(channelId: string) {
  const timer = voiceCallExpiryTimers[channelId]
  if (timer === undefined) return
  delete voiceCallExpiryTimers[channelId]
  Effect.runFork(Fiber.interrupt(timer))
}

function clearVoiceCallExpiryTimers() {
  for (const channelId of Object.keys(voiceCallExpiryTimers)) {
    clearVoiceCallExpiryTimer(channelId)
  }
}

function timestampToMs(timestamp: number | string | undefined) {
  if (timestamp === undefined) return undefined
  if (typeof timestamp === 'number') {
    return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp
  }

  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : undefined
}

function scheduleVoiceCallExpiry(call: VoiceCallState) {
  clearVoiceCallExpiryTimer(call.channelId)

  const expiresAtMs = timestampToMs(call.expiresAt)
  if (expiresAtMs === undefined) return

  const callKey = voiceCallUiKey(call)
  const delayMs = Math.max(0, expiresAtMs - Date.now())
  voiceCallExpiryTimers[call.channelId] = Effect.runFork(
    Effect.sleep(delayMs).pipe(
      Effect.andThen(
        Effect.sync(() => {
          delete voiceCallExpiryTimers[call.channelId]
          const currentCall = state.voiceCalls[call.channelId]
          if (!currentCall || voiceCallUiKey(currentCall) !== callKey) return
          if (currentCall.expiresAt !== call.expiresAt) return

          const channel = state.channels[call.channelId]
          if (
            currentCall.phase === 'ringing' &&
            channel?.channel_type === 'Group'
          ) {
            syncStore.setVoiceCall({
              ...currentCall,
              phase: 'active',
              expiresAt: expiresAtMs + GROUP_UNANSWERED_ACTIVE_MS,
              recipients: [],
            })
            return
          }

          syncStore.removeVoiceCall(call.channelId)
        }),
      ),
    ),
  )
}

function syncVoiceCallExpiryTimers(voiceCalls: Record<string, VoiceCallState>) {
  const activeChannelIds = new Set(Object.keys(voiceCalls))
  for (const channelId of Object.keys(voiceCallExpiryTimers)) {
    if (!activeChannelIds.has(channelId)) {
      clearVoiceCallExpiryTimer(channelId)
    }
  }
  for (const call of Object.values(voiceCalls)) {
    scheduleVoiceCallExpiry(call)
  }
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

function mergeChannel(
  existing: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
) {
  const decoded = Schema.decodeUnknownOption(ChannelSchema)({
    ...existing,
    ...patch,
  })
  if (Option.isNone(decoded)) {
    throw new TypeError('Invalid channel state mutation')
  }
  return decoded.value
}

function clearServerFields(server: Server, clear: ServerUpdateEvent['clear']) {
  const next = { ...server }
  for (const field of clear ?? []) {
    switch (field) {
      case 'Description':
        delete next.description
        break
      case 'Categories':
        delete next.categories
        break
      case 'SystemMessages':
        delete next.system_messages
        break
      case 'Icon':
        delete next.icon
        break
      case 'Banner':
        delete next.banner
        break
    }
  }
  return next
}

function clearRoleFields(role: Role, clear: ServerRoleUpdateEvent['clear']) {
  const next = { ...role }
  for (const field of clear ?? []) {
    switch (field) {
      case 'Colour':
        delete next.colour
        break
      case 'Icon':
        delete next.icon
        break
    }
  }
  return next
}

function clearMemberFields(
  member: Member,
  clear: ServerMemberUpdateEvent['clear'],
) {
  const next = { ...member }
  for (const field of clear ?? []) {
    switch (field) {
      case 'Roles':
        next.roles = []
        break
      case 'Nickname':
        delete next.nickname
        break
      case 'Avatar':
        delete next.avatar
        break
      case 'Timeout':
        delete next.timeout
        break
      case 'CanReceive':
        next.can_receive = true
        break
      case 'CanPublish':
        next.can_publish = true
        break
    }
  }
  return next
}

function clearChannelFields(channel: Channel, clear: FieldsChannel[] | undefined) {
  const next: Record<string, unknown> = { ...channel }
  for (const field of clear ?? []) {
    switch (field) {
      case 'Description':
        delete next.description
        break
      case 'Icon':
        delete next.icon
        break
      case 'DefaultPermissions':
        delete next.default_permissions
        break
      case 'Voice':
        delete next.voice
        break
    }
  }
  return next
}

function memberKey(member: Member) {
  return `${member._id.server}:${member._id.user}`
}

function cloneReactions(reactions: Message['reactions']) {
  if (!reactions) return {}
  return Object.fromEntries(
    Object.entries(reactions).map(([emoji, userIds]) => [emoji, [...userIds]]),
  )
}

function unreadStateFromApi(unread: ChannelUnread) {
  return {
    lastId: unread.last_id ?? null,
    mentions: [...(unread.mentions ?? [])],
  }
}

function readUnreadState(messageId: string | null) {
  return {
    lastId: messageId,
    mentions: [],
  }
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

function findVoiceParticipantInAnyChannel(userId: string) {
  for (const channelMap of Object.values(state.voiceParticipants)) {
    const participant = channelMap?.[userId]
    if (participant) return participant
  }
  return undefined
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
    left.self_mute === right.self_mute &&
    left.self_deaf === right.self_deaf &&
    left.server_muted === right.server_muted &&
    left.server_deafened === right.server_deafened &&
    left.camera === right.camera &&
    left.screensharing === right.screensharing &&
    left.version === right.version
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
    clearVoiceCallExpiryTimers()
    currentUserId = undefined
    state = emptyState()
    emit()
  },

  setCurrentUserId(userId: string | undefined) {
    currentUserId = userId
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
      unreads[unread._id.channel] = unreadStateFromApi(unread)
    }

    const voiceParticipants = mergeVoiceStatesFromReady(
      state.voiceParticipants,
      payload.voice_states,
    )
    const hasVoiceCallSnapshot = payload.voice_calls !== undefined
    const voiceCalls = hasVoiceCallSnapshot ? {} : { ...state.voiceCalls }
    for (const call of payload.voice_calls ?? []) {
      voiceCalls[call.channel_id] = {
        channelId: call.channel_id,
        initiatorId: call.initiator_id,
        phase: call.phase.toLowerCase() === 'active' ? 'active' : 'ringing',
        startedAt: call.started_at,
        expiresAt: call.expires_at,
        recipients: call.recipients ?? [],
        declinedRecipients: call.declined_recipients ?? [],
      }
    }
    const currentVoiceCallKeys = new Set(
      Object.values(voiceCalls).map(voiceCallUiKey),
    )
    const dismissedVoiceCallKeys = hasVoiceCallSnapshot
      ? Object.entries(state.dismissedVoiceCallKeys).reduce<Record<string, true>>(
          (next, [key]) => {
            if (currentVoiceCallKeys.has(key)) next[key] = true
            return next
          },
          {},
        )
      : state.dismissedVoiceCallKeys

    if (hasVoiceCallSnapshot) {
      syncVoiceCallExpiryTimers(voiceCalls)
    }

    setState({
      ready: true,
      authorization: payload.authorization ?? {
        revision: 0,
        global: 0,
        servers: {},
        channels: {},
        users: {},
      },
      servers,
      channels,
      users,
      members: membersMap,
      emojis,
      unreads,
      voiceParticipants,
      voiceCalls,
      dismissedVoiceCallKeys,
      selectedServerId: state.selectedServerId,
    })
  },

  applyServerJoinBundle({
    server,
    member,
    channels,
    emojis = [],
    voiceStates = [],
  }: ServerJoinBundle) {
    batchUpdates(() => {
      setState({
        servers: upsertRecord(state.servers, [server]),
        members: { ...state.members, [memberKey(member)]: member },
        channels: upsertRecord(state.channels, channels),
        emojis: upsertRecord(state.emojis, emojis),
      })
      for (const voiceState of voiceStates) {
        const participants: UserVoiceState[] = []
        for (const participant of voiceState.participants) {
          const normalized = normalizeUserVoiceState(participant)
          if (normalized) participants.push(normalized)
        }
        this.setChannelVoiceParticipants(
          voiceState.id,
          participants,
        )
      }
    })
  },

  applyGroupJoinBundle({ channel, users }: GroupJoinBundle) {
    setState({
      users: upsertRecord(state.users, users),
      channels: upsertRecord(state.channels, [channel]),
    })
  },

  applyInviteJoinResponse(response: InviteJoinResponse) {
    if (response.type === 'Server') {
      this.applyServerJoinBundle(response)
    } else if (response.type === 'Group') {
      this.applyGroupJoinBundle(response)
    }
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
    const existing = userCanAppearInMultipleVoiceChannels(participant.id)
      ? state.voiceParticipants[channelId]?.[participant.id]
      : findVoiceParticipantInAnyChannel(participant.id)
    if (!shouldApplyVoiceState(existing, participant)) return
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

  setVoiceCall(call: VoiceCallState) {
    const existing = state.voiceCalls[call.channelId]

    if (
      existing?.initiatorId === call.initiatorId &&
      existing.phase === call.phase &&
      existing.startedAt === call.startedAt &&
      existing.expiresAt === call.expiresAt &&
      existing.recipients.length === call.recipients.length &&
      existing.recipients.every((id, index) => id === call.recipients[index]) &&
      existing.declinedRecipients.length === call.declinedRecipients.length &&
      existing.declinedRecipients.every(
        (id, index) => id === call.declinedRecipients[index],
      )
    ) {
      scheduleVoiceCallExpiry(call)
      return
    }

    scheduleVoiceCallExpiry(call)
    setState({
      voiceCalls: {
        ...state.voiceCalls,
        [call.channelId]: call,
      },
    })
  },

  removeVoiceCall(channelId: string) {
    if (!state.voiceCalls[channelId]) return
    clearVoiceCallExpiryTimer(channelId)
    const { [channelId]: _, ...voiceCalls } = state.voiceCalls
    const dismissedVoiceCallKeys = Object.fromEntries(
      Object.entries(state.dismissedVoiceCallKeys).filter(
        ([key]) => !key.startsWith(`${channelId}:`),
      ),
    )
    setState({ voiceCalls, dismissedVoiceCallKeys })
  },

  dismissVoiceCall(call: VoiceCallState) {
    const key = voiceCallUiKey(call)
    if (state.dismissedVoiceCallKeys[key]) return

    setState({
      dismissedVoiceCallKeys: {
        ...state.dismissedVoiceCallKeys,
        [key]: true,
      },
    })
  },

  markVoiceCallDeclined(channelId: string, userId: string) {
    const call = state.voiceCalls[channelId]
    if (!call) return

    this.setVoiceCall({
      ...call,
      phase: 'active',
      expiresAt: undefined,
      recipients: call.recipients.filter((recipientId) => recipientId !== userId),
      declinedRecipients: call.declinedRecipients.includes(userId)
        ? call.declinedRecipients
        : [...call.declinedRecipients, userId],
    })
  },

  clearVoiceCallDismissal(channelId: string) {
    let changed = false
    const dismissedVoiceCallKeys = Object.fromEntries(
      Object.entries(state.dismissedVoiceCallKeys).filter(([key]) => {
        const keep = !key.startsWith(`${channelId}:`)
        changed = changed || !keep
        return keep
      }),
    )

    if (changed) setState({ dismissedVoiceCallKeys })
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
    if (voiceStateEquals(existing, normalized)) return

    const voiceParticipants = { ...state.voiceParticipants }
    if (!userCanAppearInMultipleVoiceChannels(userId)) {
      removeVoiceParticipantFromOtherChannels(
        voiceParticipants,
        userId,
        channelId,
      )
    }

    setState({
      voiceParticipants: {
        ...voiceParticipants,
        [channelId]: {
          ...(voiceParticipants[channelId] ?? {}),
          [userId]: normalized,
        },
      },
    })
  },

  moveVoiceParticipant(
    userId: string,
    fromChannelId: string,
    toChannelId: string,
    participant: UserVoiceState,
  ) {
    const existing = userCanAppearInMultipleVoiceChannels(userId)
      ? state.voiceParticipants[fromChannelId]?.[userId] ??
        state.voiceParticipants[toChannelId]?.[userId]
      : findVoiceParticipantInAnyChannel(userId)
    if (!shouldApplyVoiceState(existing, participant)) return

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
      const next = unreadStateFromApi(unread)
      const current = unreads[channelId]
      if (
        current?.lastId !== next.lastId ||
        current.mentions.length !== next.mentions.length ||
        current.mentions.some((id, index) => id !== next.mentions[index])
      ) {
        unreads[channelId] = next
        changed = true
      }
    }
    if (changed) setState({ unreads })
  },

  setChannelLastRead(channelId: string, messageId: string | null) {
    const current = state.unreads[channelId]
    if (current?.lastId === messageId && current.mentions.length === 0) return
    setState({
      unreads: { ...state.unreads, [channelId]: readUnreadState(messageId) },
    })
  },

  /** Локально снять непрочитанное со всех каналов сервера. */
  markServerChannelsRead(serverId: string) {
    const unreads = { ...state.unreads }
    let changed = false
    for (const channel of Object.values(state.channels)) {
      const channelServerId = serverChannelServerId(channel)
      if (
        channelServerId === serverId &&
        'last_message_id' in channel &&
        channel.last_message_id &&
        (unreads[channel._id]?.lastId !== channel.last_message_id ||
          unreads[channel._id]?.mentions.length)
      ) {
        unreads[channel._id] = readUnreadState(channel.last_message_id)
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
    const messages = { ...state.messages }
    const unreads = { ...state.unreads }
    const typingUsers = { ...state.typingUsers }
    const voiceParticipants = { ...state.voiceParticipants }
    const voiceCalls = { ...state.voiceCalls }
    const members = { ...state.members }
    const emojis = { ...state.emojis }
    for (const [id, channel] of Object.entries(channels)) {
      if (serverChannelServerId(channel) === serverId) {
        delete channels[id]
        delete messages[id]
        delete unreads[id]
        delete typingUsers[id]
        delete voiceParticipants[id]
        delete voiceCalls[id]
      }
    }
    for (const key of Object.keys(members)) {
      if (key.startsWith(`${serverId}:`)) {
        delete members[key]
      }
    }
    for (const [id, emoji] of Object.entries(emojis)) {
      if (emoji.parent.type === 'Server' && emoji.parent.id === serverId) {
        delete emojis[id]
      }
    }
    setState({
      servers,
      channels,
      messages,
      unreads,
      typingUsers,
      voiceParticipants,
      voiceCalls,
      members,
      emojis,
    })
  },

  upsertChannel(channel: Channel) {
    setState({
      channels: { ...state.channels, [channel._id]: channel },
    })
  },

  patchChannel(
    channelId: string,
    data: Readonly<Record<string, unknown>>,
  ) {
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
    const channels = { ...state.channels }
    const messages = { ...state.messages }
    const unreads = { ...state.unreads }
    const typingUsers = { ...state.typingUsers }
    const voiceParticipants = { ...state.voiceParticipants }
    const voiceCalls = { ...state.voiceCalls }
    delete channels[channelId]
    delete messages[channelId]
    delete unreads[channelId]
    delete typingUsers[channelId]
    delete voiceParticipants[channelId]
    delete voiceCalls[channelId]
    const dismissedVoiceCallKeys = Object.fromEntries(
      Object.entries(state.dismissedVoiceCallKeys).filter(
        ([key]) => !key.startsWith(`${channelId}:`),
      ),
    )
    clearVoiceCallExpiryTimer(channelId)
    setState({
      channels,
      messages,
      unreads,
      typingUsers,
      voiceParticipants,
      voiceCalls,
      dismissedVoiceCallKeys,
    })
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
        if (event.v.length) {
          batchUpdates(() => {
            event.v.forEach((item) => this.handleGatewayEvent(item))
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
          voice_calls,
          authorization,
        } = event
        this.applyReady({
          users,
          servers,
          channels,
          members,
          emojis,
          channel_unreads,
          voice_states,
          voice_calls,
          authorization,
        })
        break
      }
      case 'AuthorizationSnapshot': {
        const snapshot = event.snapshot
        if (snapshot.revision > state.authorization.revision) {
          setState({ authorization: snapshot })
        }
        break
      }
      case 'VoiceChannelJoin': {
        /** Voice state v1: `id` — канал, `state` — UserVoiceState (state.id — user). */
        const voiceState = normalizeUserVoiceState(event.state)
        if (voiceState) {
          this.addVoiceParticipant(event.id, voiceState)
        }
        break
      }
      case 'VoiceChannelLeave': {
        /** Voice state v1: `id` — канал, `user` — кто вышел. */
        this.removeVoiceParticipant(event.id, event.user)
        break
      }
      case 'VoiceChannelMove': {
        const voiceState = normalizeUserVoiceState(event.state)
        if (voiceState) {
          this.moveVoiceParticipant(
            event.user,
            event.from,
            event.to,
            voiceState,
          )
        }
        break
      }
      case 'VoiceStateUpdate': {
        const { channel_id, state: voiceState } = event
        const normalized = normalizeUserVoiceState(voiceState ?? {})
        if (channel_id && normalized) {
          this.addVoiceParticipant(channel_id, normalized)
        }
        break
      }
      case 'VoiceCallRinging': {
        this.setVoiceCall({
          channelId: event.channel_id,
          initiatorId: event.initiator_id,
          phase: 'ringing',
          startedAt: event.started_at,
          expiresAt: event.expires_at,
          recipients: event.recipients,
          declinedRecipients: event.declined_recipients,
        })
        break
      }
      case 'VoiceCallActive': {
        this.setVoiceCall({
          channelId: event.channel_id,
          initiatorId: event.initiator_id,
          phase: 'active',
          startedAt: event.started_at,
          expiresAt: event.expires_at,
          recipients: [],
          declinedRecipients: event.declined_recipients,
        })
        break
      }
      case 'VoiceCallEnd': {
        this.removeVoiceCall(event.channel_id)
        break
      }
      case 'MessageReact': {
        const { id, channel_id, user_id, emoji_id } = event
        this.mutateReaction(channel_id, id, emoji_id, user_id, true)
        break
      }
      case 'MessageUnreact': {
        const { id, channel_id, user_id, emoji_id } = event
        this.mutateReaction(channel_id, id, emoji_id, user_id, false)
        break
      }
      case 'MessageRemoveReaction': {
        const { id, channel_id, emoji_id } = event
        const existing = state.messages[channel_id]?.[id]
        if (!existing) break
        const reactions = cloneReactions(existing.reactions)
        delete reactions[emoji_id]
        this.patchMessage(channel_id, id, { reactions })
        break
      }
      case 'ChannelStartTyping': {
        const { id, user } = event
        this.setUserTyping(id, user, true)
        break
      }
      case 'ChannelStopTyping': {
        const { id, user } = event
        this.setUserTyping(id, user, false)
        break
      }
      case 'ChannelAck': {
        const { id, message_id } = event
        this.setChannelLastRead(id, message_id)
        break
      }
      case 'Message':
        this.upsertMessage(event)
        break
      case 'MessageUpdate': {
        const { channel, id, data } = event
        this.patchMessage(channel, id, data)
        break
      }
      case 'MessageDelete': {
        const { channel, id } = event
        this.removeMessage(channel, id)
        break
      }
      case 'BulkMessageDelete': {
        const { channel, ids } = event
        batchUpdates(() => {
          for (const id of ids) this.removeMessage(channel, id)
        })
        break
      }
      case 'ChannelCreate':
        this.upsertChannel(event)
        break
      case 'ChannelUpdate': {
        const { id, data, clear } = event
        const existing = state.channels[id]
        if (existing) {
          this.upsertChannel(
            mergeChannel(clearChannelFields(existing, clear), data),
          )
        }
        break
      }
      case 'ChannelDelete': {
        const { id } = event
        this.removeChannel(id)
        break
      }
      case 'ChannelGroupJoin': {
        const { id, user } = event
        const channel = state.channels[id]
        if (
          channel?.channel_type === 'Group' &&
          !channel.recipients.includes(user)
        ) {
          this.patchChannel(id, {
            recipients: [...channel.recipients, user],
          })
        }
        break
      }
      case 'ChannelGroupLeave': {
        const { id, user } = event
        const channel = state.channels[id]
        if (
          channel?.channel_type === 'Group' &&
          channel.recipients.includes(user)
        ) {
          this.patchChannel(id, {
            recipients: channel.recipients.filter(
              (recipientId) => recipientId !== user,
            ),
          })
        }
        this.removeVoiceParticipant(id, user)
        const call = state.voiceCalls[id]
        if (call?.phase === 'ringing' && call.recipients.includes(user)) {
          this.setVoiceCall({
            ...call,
            recipients: call.recipients.filter(
              (recipientId) => recipientId !== user,
            ),
          })
        }
        break
      }
      case 'ServerCreate': {
        const { server, member, channels, emojis, voice_states } = event
        this.applyServerJoinBundle({
          server,
          member,
          channels,
          emojis,
          voiceStates: voice_states,
        })
        break
      }
      case 'ServerUpdate': {
        const { id, data, clear } = event
        const existing = state.servers[id]
        if (existing) {
          this.upsertServer({ ...clearServerFields(existing, clear), ...data })
        }
        break
      }
      case 'ServerDelete': {
        const { id } = event
        this.removeServer(id)
        break
      }
      case 'ServerRoleUpdate': {
        const { id, role_id, data, clear } = event
        const server = state.servers[id]
        if (!server) break
        const existing = server.roles?.[role_id]
        const decodedRole = Schema.decodeUnknownOption(RoleSchema)({
          ...(existing ? clearRoleFields(existing, clear) : {}),
          ...data,
          _id: role_id,
        })
        if (Option.isNone(decodedRole)) break
        const roles = {
          ...server.roles,
          [role_id]: decodedRole.value,
        }
        this.upsertServer({ ...server, roles })
        break
      }
      case 'ServerRoleRanksUpdate': {
        const { id, ranks } = event
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
        const { id, role_id } = event
        const server = state.servers[id]
        if (!server) break

        const servers = { ...state.servers }
        if (server.roles) {
          const { [role_id]: _, ...roles } = server.roles
          servers[id] = { ...server, roles }
        }

        const members = { ...state.members }
        for (const [key, member] of Object.entries(members)) {
          if (member._id.server !== id || !member.roles?.includes(role_id)) {
            continue
          }

          members[key] = {
            ...member,
            roles: member.roles.filter(
              (memberRoleId) => memberRoleId !== role_id,
            ),
          }
        }

        const channels = { ...state.channels }
        for (const [channelId, channel] of Object.entries(channels)) {
          if (
            channel.channel_type !== 'TextChannel' ||
            channel.server !== id ||
            !channel.role_permissions?.[role_id]
          ) {
            continue
          }

          const { [role_id]: _, ...rolePermissions } = channel.role_permissions
          channels[channelId] = {
            ...channel,
            role_permissions: rolePermissions,
          }
        }

        setState({ servers, members, channels })
        break
      }
      case 'UserUpdate': {
        const { id, data } = event
        const existing = state.users[id]
        if (existing) {
          this.upsertUser({ ...existing, ...data })
        }
        break
      }
      case 'UserRelationship': {
        const { user } = event
        this.upsertUser(user)
        break
      }
      case 'UserPresence': {
        const { id, online } = event
        const existing = state.users[id]
        if (existing) {
          this.upsertUser({ ...existing, online })
        }
        break
      }
      case 'EmojiCreate':
        this.upsertEmoji(event)
        break
      case 'EmojiDelete': {
        const { id } = event
        this.removeEmoji(id)
        break
      }
      case 'ServerMemberUpdate': {
        const { id, data, clear } = event
        const key = `${id.server}:${id.user}`
        const existing = state.members[key]
        const decodedMember = Schema.decodeUnknownOption(MemberSchema)({
          ...(existing ? clearMemberFields(existing, clear) : {}),
          ...data,
          _id: existing?._id ?? id,
        })
        if (Option.isNone(decodedMember)) break

        this.upsertMembers([decodedMember.value])
        break
      }
      case 'ServerMemberJoin': {
        this.upsertMembers([event.member])
        break
      }
      case 'ServerMemberLeave': {
        const { id: serverId, user: userId } = event
        if (userId === currentUserId) {
          this.removeServer(serverId)
          if (state.selectedServerId === serverId) {
            this.setSelectedServerId(null)
          }
          break
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
  const cacheRef = useRef<{
    store: SyncState
    selector: (state: SyncState) => T
    value: T
  } | null>(null)

  const getSnapshot = () => {
    const store = syncStore.getState()
    if (
      cacheRef.current?.store === store &&
      cacheRef.current.selector === selector
    ) {
      return cacheRef.current.value
    }
    const value = selector(store)
    cacheRef.current = { store, selector, value }
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
