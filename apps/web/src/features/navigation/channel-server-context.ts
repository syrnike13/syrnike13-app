import type { Channel } from '@syrnike13/api-types'

import { isDmChannel } from '#/features/sync/channel-label'
import { serverChannelServerId } from '#/lib/channel-voice'

export function selectedServerIdForChannel(
  channel: Channel | undefined,
): string | null {
  if (!channel || isDmChannel(channel)) return null
  return serverChannelServerId(channel) ?? null
}
