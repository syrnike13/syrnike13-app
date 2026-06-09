import type { Channel } from '@syrnike13/api-types'

import {
  channelHasVoice,
  isServerVoiceChannel,
  isVoiceOnlyChannel,
} from '#/lib/channel-voice'

export function canJoinVoiceChannel(channel: Channel | undefined) {
  if (!channel) return false
  if (isVoiceOnlyChannel(channel)) return true
  if (isServerVoiceChannel(channel)) return true
  if (channelHasVoice(channel)) return true
  return false
}
