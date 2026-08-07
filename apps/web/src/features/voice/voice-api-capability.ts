import type { Channel } from '@syrnike13/api-types'

import {
  channelHasVoice,
  isServerVoiceChannel,
} from '#/lib/channel-voice'

export function canJoinVoiceChannel(channel: Channel | undefined) {
  if (!channel) return false
  if (isServerVoiceChannel(channel)) return true
  if (channelHasVoice(channel)) return true
  return false
}
