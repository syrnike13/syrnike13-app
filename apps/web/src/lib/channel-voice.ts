import type { Channel } from '@syrnike13/api-types'

type RuntimeChannelFields = {
  _id: string
  channel_type: string
  server?: string
  name?: string | null
}

function runtimeChannel(channel: Channel): RuntimeChannelFields {
  return channel as unknown as RuntimeChannelFields
}

function hasVoiceInfo(channel: Channel): boolean {
  return 'voice' in channel && channel.voice != null
}

export function channelRuntimeType(channel: Channel) {
  return runtimeChannel(channel).channel_type
}

export function isLegacyVoiceChannel(channel: Channel) {
  return channelRuntimeType(channel) === 'VoiceChannel'
}

export function runtimeChannelName(channel: Channel) {
  return runtimeChannel(channel).name ?? undefined
}

export function serverChannelServerId(channel: Channel | undefined) {
  if (!channel) return undefined
  if (channel.channel_type === 'TextChannel') return channel.server
  if (isLegacyVoiceChannel(channel)) return runtimeChannel(channel).server
  return undefined
}

/** Канал поддерживает голос (в т.ч. ЛС/группы и TextChannel + voice v2). */
export function channelHasVoice(channel: Channel) {
  if (isLegacyVoiceChannel(channel)) return true
  if (channel.channel_type === 'DirectMessage' || channel.channel_type === 'Group') {
    return true
  }
  if (channel.channel_type === 'TextChannel') {
    return hasVoiceInfo(channel)
  }
  return false
}

/**
 * Голосовой канал на сервере.
 * В API v2 это TextChannel с `voice`; тип VoiceChannel — legacy.
 */
export function isServerVoiceChannel(channel: Channel) {
  if (isLegacyVoiceChannel(channel)) return true
  return channel.channel_type === 'TextChannel' && hasVoiceInfo(channel)
}

/** Отдельный экран без текстовой ленты (только legacy VoiceChannel). */
export function isVoiceOnlyChannel(channel: Channel) {
  return isLegacyVoiceChannel(channel)
}

/** После POST /channels: API v2 иногда не проставляет `voice` сразу. */
export function normalizeServerChannel(
  channel: Channel,
  requestedType?: 'Text' | 'Voice',
): Channel {
  if (
    requestedType === 'Voice' &&
    channel.channel_type === 'TextChannel' &&
    !hasVoiceInfo(channel)
  ) {
    return { ...channel, voice: { max_users: null } }
  }
  return channel
}
