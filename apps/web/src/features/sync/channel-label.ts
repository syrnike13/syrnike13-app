import type { Channel, User } from '@syrnike13/api-types'
import {
  isLegacyVoiceChannel,
  runtimeChannelName,
} from '#/lib/channel-voice'

export function getChannelLabel(
  channel: Channel,
  users: Record<string, User>,
  currentUserId?: string,
): string {
  if (isLegacyVoiceChannel(channel)) {
    return runtimeChannelName(channel) || 'Голосовой канал'
  }

  switch (channel.channel_type) {
    case 'SavedMessages':
      return 'Сохранённые'
    case 'DirectMessage': {
      const otherId = channel.recipients.find((id) => id !== currentUserId)
      const other = otherId ? users[otherId] : undefined
      return other?.display_name ?? other?.username ?? 'Личные сообщения'
    }
    case 'Group':
      return channel.name
    case 'TextChannel':
      return channel.name
    default:
      return 'Канал'
  }
}

export function isDmChannel(channel: Channel) {
  return (
    channel.channel_type === 'DirectMessage' ||
    channel.channel_type === 'Group' ||
    channel.channel_type === 'SavedMessages'
  )
}

export function getDmRecipientId(
  channel: Channel,
  currentUserId?: string,
): string | undefined {
  if (channel.channel_type !== 'DirectMessage') return undefined
  return channel.recipients.find((id) => id !== currentUserId)
}

export function isTextChannel(channel: Channel) {
  return (
    channel.channel_type === 'TextChannel' ||
    channel.channel_type === 'DirectMessage' ||
    channel.channel_type === 'Group'
  )
}
