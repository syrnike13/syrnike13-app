import type { Channel } from '@syrnike13/api-types'

export type ServerTextChannel = Extract<Channel, { channel_type: 'TextChannel' }>
export type RuntimeChannel = Channel
export type ServerChannel = ServerTextChannel

function hasVoiceInfo(channel: Channel): boolean {
  return 'voice' in channel && channel.voice != null
}

export function isServerChannel(
  channel: Channel | undefined,
): channel is ServerChannel {
  return channel?.channel_type === 'TextChannel'
}

export function runtimeChannelName(channel: Channel) {
  return 'name' in channel ? channel.name : undefined
}

export function serverChannelServerId(channel: Channel | undefined) {
  if (!channel) return undefined
  if (channel.channel_type === 'TextChannel') return channel.server
  return undefined
}

/** Канал поддерживает голос (в т.ч. ЛС/группы и TextChannel + voice v2). */
export function channelHasVoice(channel: Channel) {
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
 * В API v2 это TextChannel с `voice`.
 */
export function isServerVoiceChannel(channel: Channel) {
  return channel.channel_type === 'TextChannel' && hasVoiceInfo(channel)
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
