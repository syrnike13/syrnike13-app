import type { Channel } from '@syrnike13/api-types'

export type ServerTextChannel = Extract<Channel, { channel_type: 'TextChannel' }>
export type LegacyVoiceChannel = Omit<ServerTextChannel, 'channel_type'> & {
  channel_type: 'VoiceChannel'
}
export type RuntimeChannel = Channel | LegacyVoiceChannel
export type ServerChannel = ServerTextChannel | LegacyVoiceChannel

type RuntimeChannelFields = {
  _id: string
  channel_type: string
  server?: string
  name?: string | null
}

function runtimeChannel(channel: RuntimeChannel): RuntimeChannelFields {
  return channel as unknown as RuntimeChannelFields
}

function hasVoiceInfo(channel: RuntimeChannel): boolean {
  return 'voice' in channel && channel.voice != null
}

export function channelRuntimeType(channel: RuntimeChannel) {
  return runtimeChannel(channel).channel_type
}

export function isLegacyVoiceChannel(channel: RuntimeChannel) {
  return channelRuntimeType(channel) === 'VoiceChannel'
}

export function isServerChannel(
  channel: RuntimeChannel | undefined,
): channel is ServerChannel {
  return Boolean(
    channel &&
      (channel.channel_type === 'TextChannel' || isLegacyVoiceChannel(channel)),
  )
}

export function runtimeChannelName(channel: RuntimeChannel) {
  return runtimeChannel(channel).name ?? undefined
}

export function serverChannelServerId(channel: RuntimeChannel | undefined) {
  if (!channel) return undefined
  if (channel.channel_type === 'TextChannel') return channel.server
  if (isLegacyVoiceChannel(channel)) return runtimeChannel(channel).server
  return undefined
}

/** Канал поддерживает голос (в т.ч. ЛС/группы и TextChannel + voice v2). */
export function channelHasVoice(channel: RuntimeChannel) {
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
export function isServerVoiceChannel(channel: RuntimeChannel) {
  if (isLegacyVoiceChannel(channel)) return true
  return channel.channel_type === 'TextChannel' && hasVoiceInfo(channel)
}

/** Отдельный экран без текстовой ленты (только legacy VoiceChannel). */
export function isVoiceOnlyChannel(channel: RuntimeChannel) {
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
