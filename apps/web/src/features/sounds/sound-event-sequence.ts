import type { GatewayServerEvent } from '#/features/sync/types'
import type {
  UserVoiceState,
  VoiceParticipantsByChannel,
} from '#/features/sync/voice-types'

import {
  soundEventFromGatewayEvent,
  type SoundEventContext,
  type SoundVoiceMediaState,
} from './sound-event-map'
import type { SoundEventId } from './sound-events'

type SequenceSoundContext = Omit<SoundEventContext, 'previousVoiceState'>

function voiceMediaKey(channelId: string, userId: string) {
  return `${channelId}:${userId}`
}

function voiceStateUserId(event: GatewayServerEvent) {
  if (typeof event.state?.id === 'string') return event.state.id
  if (typeof event.state?.user === 'string') return event.state.user
  if (typeof event.state?.user_id === 'string') return event.state.user_id
  if (typeof event.user === 'string') return event.user
  if (typeof event.user_id === 'string') return event.user_id
  return null
}

function voiceMediaStateFromState(
  state: Partial<UserVoiceState> | undefined,
  previous?: SoundVoiceMediaState | null,
): SoundVoiceMediaState | null {
  if (!state) return previous ? { ...previous } : null
  const hasScreensharing = Object.prototype.hasOwnProperty.call(
    state,
    'screensharing',
  )
  const hasCamera = Object.prototype.hasOwnProperty.call(state, 'camera')
  if (!hasScreensharing && !hasCamera) {
    return previous ? { ...previous } : null
  }
  return {
    screensharing: hasScreensharing
      ? Boolean(state.screensharing)
      : previous?.screensharing ?? false,
    camera: hasCamera ? Boolean(state.camera) : previous?.camera ?? false,
  }
}

function voiceMediaStateFromEvent(
  event: GatewayServerEvent,
  previous?: SoundVoiceMediaState | null,
) {
  return voiceMediaStateFromState(event.state, previous)
}

function voiceChannelIdFromJoin(event: GatewayServerEvent) {
  if (typeof event.channel === 'string') return event.channel
  if (typeof event.channel_id === 'string') return event.channel_id
  if (typeof event.id === 'string') return event.id
  return null
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

function previousVoiceMediaState(
  event: GatewayServerEvent,
  cache: ReadonlyMap<string, SoundVoiceMediaState>,
) {
  if (event.type !== 'VoiceStateUpdate') return null
  const channelId =
    typeof event.channel_id === 'string' ? event.channel_id : null
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
    const voiceStates = Array.isArray(event.voice_states)
      ? event.voice_states
      : null
    if (!voiceStates) return
    cache.clear()
    for (const entry of voiceStates) {
      const channelId =
        typeof entry.id === 'string'
          ? entry.id
          : typeof entry.channel_id === 'string'
            ? entry.channel_id
            : typeof entry.channel === 'string'
              ? entry.channel
              : null
      if (!channelId || !Array.isArray(entry.participants)) continue
      for (const participant of entry.participants) {
        if (!participant || typeof participant !== 'object') continue
        const userId = voiceStateUserId({ state: participant })
        const mediaState = voiceMediaStateFromState(participant)
        if (userId && mediaState) {
          cache.set(voiceMediaKey(channelId, userId), mediaState)
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
    const userId = voiceStateUserId(event)
    if (userId && typeof event.from === 'string') {
      cache.delete(voiceMediaKey(event.from, userId))
    }
    if (userId && typeof event.to === 'string') {
      const mediaState = voiceMediaStateFromEvent(
        event,
        cache.get(voiceMediaKey(event.to, userId)),
      )
      if (mediaState) cache.set(voiceMediaKey(event.to, userId), mediaState)
    }
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
    const channelId =
      typeof event.channel_id === 'string' ? event.channel_id : null
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
) {
  if (event.type === 'Ready') {
    const voiceStates = Array.isArray(event.voice_states)
      ? event.voice_states
      : null
    if (!voiceStates) return
    channels.clear()
    for (const entry of voiceStates) {
      const channelId =
        typeof entry.id === 'string'
          ? entry.id
          : typeof entry.channel_id === 'string'
            ? entry.channel_id
            : typeof entry.channel === 'string'
              ? entry.channel
              : null
      if (!channelId || !Array.isArray(entry.participants)) continue
      for (const participant of entry.participants) {
        if (!participant || typeof participant !== 'object') continue
        const userId = voiceStateUserId({ state: participant })
        if (userId) channels.set(userId, channelId)
      }
    }
    return
  }

  if (event.type === 'VoiceChannelLeave') {
    const channelId = voiceChannelIdFromJoin(event)
    const userId = voiceStateUserId(event)
    if (channelId && userId && channels.get(userId) === channelId) {
      channels.delete(userId)
    }
    return
  }

  if (event.type === 'VoiceChannelMove') {
    const userId = voiceStateUserId(event)
    if (!userId) return
    if (typeof event.from === 'string' && channels.get(userId) === event.from) {
      channels.delete(userId)
    }
    if (typeof event.to === 'string') channels.set(userId, event.to)
    return
  }

  if (event.type === 'VoiceChannelJoin') {
    const channelId = voiceChannelIdFromJoin(event)
    const userId = voiceStateUserId(event)
    if (channelId && userId) channels.set(userId, channelId)
    return
  }

  if (event.type === 'VoiceStateUpdate') {
    const channelId =
      typeof event.channel_id === 'string' ? event.channel_id : null
    const userId = voiceStateUserId(event)
    if (channelId && userId) channels.set(userId, channelId)
    return
  }

  if (event.type === 'ChannelDelete' && typeof event.id === 'string') {
    deleteChannelVoiceMemberships(channels, event.id)
  }
}

function currentVoiceChannelIdForContext(
  context: SequenceSoundContext,
  channels: ReadonlyMap<string, string>,
) {
  const currentUserId = context.currentUserId
  if (!currentUserId) return context.currentVoiceChannelId ?? null
  return channels.get(currentUserId) ?? context.currentVoiceChannelId ?? null
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

  function resolveSingle(
    event: GatewayServerEvent,
    context: SequenceSoundContext,
  ) {
    const soundEvent = soundEventFromGatewayEvent(event, {
      ...context,
      currentVoiceChannelId: currentVoiceChannelIdForContext(
        context,
        voiceChannelIds,
      ),
      previousVoiceState: previousVoiceMediaState(event, voiceMediaStates),
    })
    updateVoiceMediaStates(event, voiceMediaStates)
    updateVoiceChannelIds(event, voiceChannelIds)
    return soundEvent ? [soundEvent] : []
  }

  function resolve(
    event: GatewayServerEvent,
    context: SequenceSoundContext,
  ): SoundEventId[] {
    if (event.type !== 'Bulk') return resolveSingle(event, context)
    const items = Array.isArray(event.v) ? event.v : []
    return items.flatMap((item) =>
      resolve(item as GatewayServerEvent, context),
    )
  }

  return {
    resolve,
  }
}
