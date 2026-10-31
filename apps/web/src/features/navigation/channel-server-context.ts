import type { Channel } from '@syrnike13/api-types'

import { isDmChannel } from '@syrnike13/client/sync/channel-label'
import { serverChannelServerId } from '@syrnike13/client/lib/channel-voice'

export function selectedServerIdForChannel(
  channel: Channel | undefined,
): string | null {
  if (!channel || isDmChannel(channel)) return null
  return serverChannelServerId(channel) ?? null
}
