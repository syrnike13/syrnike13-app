import type { Channel } from '@syrnike13/api-types'

function hasVoiceInfo(channel: Channel): boolean {
  return 'voice' in channel && channel.voice != null
}

/** Канал поддерживает голос (в т.ч. ЛС/группы и TextChannel + voice v2). */
export function channelHasVoice(channel: Channel) {
  if (channel.channel_type === 'VoiceChannel') return true
  if (
    channel.channel_type === 'TextChannel' ||
    channel.channel_type === 'DirectMessage' ||
    channel.channel_type === 'Group'
  ) {
    return hasVoiceInfo(channel)
  }
  return false
}

/**
 * Голосовой канал на сервере.
 * В API v2 это TextChannel с `voice`; тип VoiceChannel — legacy.
 */
export function isServerVoiceChannel(channel: Channel) {
  if (channel.channel_type === 'VoiceChannel') return true
  return channel.channel_type === 'TextChannel' && hasVoiceInfo(channel)
}

/** Отдельный экран без текстовой ленты (только legacy VoiceChannel). */
export function isVoiceOnlyChannel(channel: Channel) {
  return channel.channel_type === 'VoiceChannel'
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
