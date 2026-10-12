import type { Server } from '@syrnike13/api-types'

export function getServerDescription(server: Server | undefined): string | null {
  if (server?.description?.trim()) {
    return server.description.trim()
  }
  return null
}
