import type { GatewayServerEvent } from '#/features/sync/types'
import type { UserVoiceState as GatewayUserVoiceState } from '@syrnike13/api-types/gateway-schema'
import type {
  VoiceParticipantsByChannel,
} from '#/features/sync/voice-types'

import {
  soundEventFromGatewayEvent,
  type SoundEventContext,
  type SoundVoiceMediaState,
} from './sound-event-map'
import type { SoundEventId } from './sound-events'

type SequenceSoundContext = Omit<SoundEventContext, 'previousVoiceState'>
type VoiceMembershipEvent = Extract<
  GatewayServerEvent,
  {
    type:
      | 'VoiceChannelJoin'
      | 'VoiceChannelLeave'
      | 'VoiceChannelMove'
      | 'VoiceStateUpdate'
  }
>
type VoiceStateCarrierEvent = Extract<
  VoiceMembershipEvent,
  { type: 'VoiceChannelJoin' | 'VoiceChannelMove' | 'VoiceStateUpdate' }
>
type VoiceJoinLeaveEvent = Extract<
  VoiceMembershipEvent,
  { type: 'VoiceChannelJoin' | 'VoiceChannelLeave' }
>

function voiceMediaKey(channelId: string, userId: string) {
  return `${channelId}:${userId}`
}

function voiceStateUserId(event: VoiceMembershipEvent) {
  switch (event.type) {
    case 'VoiceChannelLeave':
    case 'VoiceChannelMove':
      return event.user
    case 'VoiceChannelJoin':
    case 'VoiceStateUpdate':
      return event.state.id
  }
}

function voiceMediaStateFromState(
  state: Partial<GatewayUserVoiceState> | undefined,
  previous?: SoundVoiceMediaState | null,
): SoundVoiceMediaState | null {
  if (!state) return previous ? { ...previous } : null
  const hasScreensharing = Object.prototype.hasOwnProperty.call(
    state,
    'screensharing',
  )
  const hasCamera = Object.prototype.hasOwnProperty.call(state, 'camera')
  const hasSelfMuted = Object.prototype.hasOwnProperty.call(state, 'self_mute')
  const hasSelfDeafened = Object.prototype.hasOwnProperty.call(
    state,
    'self_deaf',
  )
  if (!hasScreensharing && !hasCamera && !hasSelfMuted && !hasSelfDeafened) {
    return previous ? { ...previous } : null
  }
  return {
    screensharing: hasScreensharing
      ? Boolean(state.screensharing)
      : previous?.screensharing ?? false,
    camera: hasCamera ? Boolean(state.camera) : previous?.camera ?? false,
    selfMuted: hasSelfMuted
      ? Boolean(state.self_mute)
      : previous?.selfMuted ?? false,
    selfDeafened: hasSelfDeafened
      ? Boolean(state.self_deaf)
      : previous?.selfDeafened ?? false,
  }
}

function voiceMediaStateFromEvent(
  event: VoiceStateCarrierEvent,
  previous?: SoundVoiceMediaState | null,
) {
  return voiceMediaStateFromState(event.state, previous)
}

function voiceChannelIdFromJoin(event: VoiceJoinLeaveEvent) {
  return event.id
}

function seedVoiceMediaStates(voiceParticipants?: VoiceParticipantsByChannel) {
  const cache = new Map<string, SoundVoiceMediaState>()
  for (const [channelId, participants] of Object.entries(
    voiceParticipants ?? {},
  )) {
    for (const participant of Object.values(participants)) {
      cache.set(voiceMediaKey(channelId, participant.id), {
        screensharing: participant.screensharing,
        camera: participant.camera,
        selfMuted: participant.self_mute,
        selfDeafened: participant.self_deaf,
      })
    }
  }
  return cache
}

function seedVoiceChannelIds(voiceParticipants?: VoiceParticipantsByChannel) {
  const channels = new Map<string, string>()
  for (const [channelId, participants] of Object.entries(
    voiceParticipants ?? {},
  )) {
    for (const participant of Object.values(participants)) {
      channels.set(participant.id, channelId)
    }
  }
  return channels
}

function seedKnownVoiceMemberships(
  voiceParticipants?: VoiceParticipantsByChannel,
) {
  const users = new Set<string>()
  for (const participants of Object.values(voiceParticipants ?? {})) {
    for (const participant of Object.values(participants)) {
      users.add(participant.id)
    }
  }
  return users
}

function previousVoiceMediaState(
  event: GatewayServerEvent,
  cache: ReadonlyMap<string, SoundVoiceMediaState>,
) {
  if (event.type !== 'VoiceStateUpdate') return null
  const channelId = event.channel_id
  const userId = voiceStateUserId(event)
  if (!channelId || !userId) return null
  return cache.get(voiceMediaKey(channelId, userId)) ?? null
}

function deleteChannelVoiceMediaStates(
  cache: Map<string, SoundVoiceMediaState>,
  channelId: string,
) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${channelId}:`)) cache.delete(key)
  }
}

function updateVoiceMediaStates(
  event: GatewayServerEvent,
  cache: Map<string, SoundVoiceMediaState>,
) {
  if (event.type === 'Ready') {
    const voiceStates = event.voice_states
    if (!voiceStates) return
    cache.clear()
    for (const entry of voiceStates) {
      const channelId = entry.id
      for (const participant of entry.participants) {
        const mediaState = voiceMediaStateFromState(participant)
        if (mediaState) {
          cache.set(voiceMediaKey(channelId, participant.id), mediaState)
        }
      }
    }
    return
  }

  if (event.type === 'VoiceChannelLeave') {
    const channelId = voiceChannelIdFromJoin(event)
    const userId = voiceStateUserId(event)
    if (channelId && userId) cache.delete(voiceMediaKey(channelId, userId))
    return
  }

  if (event.type === 'VoiceChannelMove') {
    const userId = event.user
    cache.delete(voiceMediaKey(event.from, userId))
    const mediaState = voiceMediaStateFromEvent(
      event,
      cache.get(voiceMediaKey(event.to, userId)),
    )
    if (mediaState) cache.set(voiceMediaKey(event.to, userId), mediaState)
    return
  }

  if (event.type === 'VoiceChannelJoin') {
    const channelId = voiceChannelIdFromJoin(event)
    const userId = voiceStateUserId(event)
    const mediaState = voiceMediaStateFromEvent(
      event,
      channelId && userId ? cache.get(voiceMediaKey(channelId, userId)) : null,
    )
    if (channelId && userId && mediaState) {
      cache.set(voiceMediaKey(channelId, userId), mediaState)
    }
    return
  }

  if (event.type === 'VoiceStateUpdate') {
    const channelId = event.channel_id
    const userId = voiceStateUserId(event)
    const mediaState = voiceMediaStateFromEvent(
      event,
      channelId && userId ? cache.get(voiceMediaKey(channelId, userId)) : null,
    )
    if (channelId && userId && mediaState) {
      cache.set(voiceMediaKey(channelId, userId), mediaState)
    }
    return
  }

  if (event.type === 'ChannelDelete' && typeof event.id === 'string') {
    deleteChannelVoiceMediaStates(cache, event.id)
  }
}

function deleteChannelVoiceMemberships(
  channels: Map<string, string>,
  channelId: string,
) {
  for (const [userId, userChannelId] of channels.entries()) {
    if (userChannelId === channelId) channels.delete(userId)
  }
}

function updateVoiceChannelIds(
  event: GatewayServerEvent,
  channels: Map<string, string>,
  knownMemberships: Set<string>,
  currentUserId?: string | null,
) {
  if (event.type === 'Ready') {
    const voiceStates = event.voice_states
    if (!voiceStates) return
    channels.clear()
    knownMemberships.clear()
    for (const entry of voiceStates) {
      const channelId = entry.id
      for (const participant of entry.participants) {
        channels.set(participant.id, channelId)
        knownMemberships.add(participant.id)
      }
    }
    if (currentUserId) knownMemberships.add(currentUserId)
    return
  }

  if (event.type === 'VoiceChannelLeave') {
    const channelId = voiceChannelIdFromJoin(event)
    const userId = voiceStateUserId(event)
    if (userId) knownMemberships.add(userId)
    if (channelId && userId && channels.get(userId) === channelId) {
      channels.delete(userId)
    }
    return
  }

  if (event.type === 'VoiceChannelMove') {
    const userId = event.user
    knownMemberships.add(userId)
    if (channels.get(userId) === event.from) {
      channels.delete(userId)
    }
    channels.set(userId, event.to)
    return
  }

  if (event.type === 'VoiceChannelJoin') {
    const channelId = voiceChannelIdFromJoin(event)
    const userId = voiceStateUserId(event)
    if (userId) knownMemberships.add(userId)
    if (channelId && userId) channels.set(userId, channelId)
    return
  }

  if (event.type === 'VoiceStateUpdate') {
    const channelId = event.channel_id
    const userId = voiceStateUserId(event)
    if (userId) knownMemberships.add(userId)
    if (channelId && userId) channels.set(userId, channelId)
    return
  }

  if (event.type === 'ChannelDelete') {
    deleteChannelVoiceMemberships(channels, event.id)
  }
}

function currentVoiceChannelIdForContext(
  context: SequenceSoundContext,
  channels: ReadonlyMap<string, string>,
  knownMemberships: ReadonlySet<string>,
) {
  const currentUserId = context.currentUserId
  if (!currentUserId) return context.currentVoiceChannelId ?? null
  if (knownMemberships.has(currentUserId)) {
    return channels.get(currentUserId) ?? null
  }
  return channels.get(currentUserId) ?? context.currentVoiceChannelId ?? null
}

function repeatsKnownVoiceMembership(
  event: GatewayServerEvent,
  channels: ReadonlyMap<string, string>,
) {
  if (
    event.type !== 'VoiceChannelJoin' &&
    event.type !== 'VoiceChannelLeave' &&
    event.type !== 'VoiceChannelMove'
  ) {
    return false
  }
  const userId = voiceStateUserId(event)

  if (event.type === 'VoiceChannelJoin') {
    const channelId = voiceChannelIdFromJoin(event)
    return channelId != null && channels.get(userId) === channelId
  }
  if (event.type === 'VoiceChannelLeave') {
    const channelId = voiceChannelIdFromJoin(event)
    return channelId != null && channels.get(userId) !== channelId
  }
  if (event.type === 'VoiceChannelMove') {
    return channels.get(userId) === event.to
  }
  return false
}

export function currentVoiceChannelIdFromParticipants(
  voiceParticipants: VoiceParticipantsByChannel,
  currentUserId: string | null | undefined,
) {
  if (!currentUserId) return null
  for (const [channelId, participants] of Object.entries(voiceParticipants)) {
    if (participants[currentUserId]) return channelId
  }
  return null
}

export function createSoundEventResolver(
  voiceParticipants?: VoiceParticipantsByChannel,
) {
  const voiceMediaStates = seedVoiceMediaStates(voiceParticipants)
  const voiceChannelIds = seedVoiceChannelIds(voiceParticipants)
  const knownVoiceMemberships = seedKnownVoiceMemberships(voiceParticipants)

  function resolveSingle(
    event: GatewayServerEvent,
    context: SequenceSoundContext,
  ) {
    const soundEvent = repeatsKnownVoiceMembership(event, voiceChannelIds)
      ? null
      : soundEventFromGatewayEvent(event, {
          ...context,
          currentVoiceChannelId: currentVoiceChannelIdForContext(
            context,
            voiceChannelIds,
            knownVoiceMemberships,
          ),
          previousVoiceState: previousVoiceMediaState(event, voiceMediaStates),
        })
    updateVoiceMediaStates(event, voiceMediaStates)
    updateVoiceChannelIds(
      event,
      voiceChannelIds,
      knownVoiceMemberships,
      context.currentUserId,
    )
    return soundEvent ? [soundEvent] : []
  }

  function resolve(
    event: GatewayServerEvent,
    context: SequenceSoundContext,
  ): SoundEventId[] {
    if (event.type !== 'Bulk') return resolveSingle(event, context)
    return event.v.flatMap((item) => resolve(item, context))
  }

  return {
    resolve,
  }
}
