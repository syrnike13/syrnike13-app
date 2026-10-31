import type { Channel, User } from '@syrnike13/api-types'

/** Any app translator: only the fallback labels below are looked up. */
type Translator = (key: 'savedMessages' | 'directMessages' | 'channelFallback') => string

/** Sorting callers do not render fallback labels, so they can skip localization. */
const EMPTY_LABELS: Translator = () => ''

export function getChannelLabel(
  channel: Channel,
  users: Record<string, User>,
  currentUserId: string | undefined,
  t: Translator = EMPTY_LABELS,
): string {
  switch (channel.channel_type) {
    case 'SavedMessages':
      return t('savedMessages')
    case 'DirectMessage': {
      const otherId = channel.recipients.find((id) => id !== currentUserId)
      const other = otherId ? users[otherId] : undefined
      return other?.display_name ?? other?.username ?? t('directMessages')
    }
    case 'Group':
      return channel.name
    case 'TextChannel':
      return channel.name
    default:
      return t('channelFallback')
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
