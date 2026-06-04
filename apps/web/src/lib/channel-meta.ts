import type { Channel, Server } from '@syrnike13/api-types'

export function getChannelDescription(channel: Channel): string | null {
  if (
    'description' in channel &&
    typeof channel.description === 'string' &&
    channel.description.trim()
  ) {
    return channel.description.trim()
  }
  return null
}

export function getServerDescription(server: Server | undefined): string | null {
  if (server?.description?.trim()) {
    return server.description.trim()
  }
  return null
}
