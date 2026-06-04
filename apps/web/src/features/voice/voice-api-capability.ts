import type { Channel } from '@syrnike13/api-types'

import { ApiError } from '#/lib/api/client'
import {
  channelHasVoice,
  isServerVoiceChannel,
  isVoiceOnlyChannel,
} from '#/lib/channel-voice'

/** Каналы, для которых бекенд отклонил voice REST (400/404). */
const unsupportedChannelIds = new Set<string>()

export function isVoiceApiSupported(channelId: string) {
  return !unsupportedChannelIds.has(channelId)
}

export function markVoiceApiUnsupported(channelId: string) {
  unsupportedChannelIds.add(channelId)
}

export function clearVoiceApiUnsupported(channelId: string) {
  unsupportedChannelIds.delete(channelId)
}

export function handleVoiceApiError(channelId: string, error: unknown) {
  if (
    error instanceof ApiError &&
    (error.status === 400 || error.status === 404)
  ) {
    markVoiceApiUnsupported(channelId)
    return true
  }
  return false
}

/** Можно вызывать `join_call` для этого канала. */
export function canUseVoiceRestApi(channel: Channel | undefined) {
  if (!channel || !isVoiceApiSupported(channel._id)) return false
  if (isVoiceOnlyChannel(channel)) return true
  if (isServerVoiceChannel(channel)) return true
  if (channelHasVoice(channel)) return true
  return false
}
