import type { Channel } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { openDirectMessage as openDirectMessageApi } from '#/features/api/users-api'
import { syncStore } from '#/features/sync/sync-store'

type NavigateToDmChannel = (channelId: string) => Promise<void> | void

export type DmActionDeps = {
  openDirectMessage: typeof openDirectMessageApi
  upsertChannel: (channel: Channel) => void
  setSelectedServerId: (serverId: string | null) => void
  toastError: (message: string) => void
}

const defaultDeps: DmActionDeps = {
  openDirectMessage: openDirectMessageApi,
  upsertChannel: syncStore.upsertChannel,
  setSelectedServerId: syncStore.setSelectedServerId,
  toastError: toast.error,
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export async function openDirectMessageChannel(
  token: string,
  userId: string,
  navigateToChannel: NavigateToDmChannel,
  deps: DmActionDeps = defaultDeps,
) {
  try {
    const channel = await deps.openDirectMessage(token, userId)
    deps.upsertChannel(channel)
    deps.setSelectedServerId(null)
    await navigateToChannel(channel._id)
    return channel
  } catch (error) {
    deps.toastError(errorMessage(error, 'Не удалось открыть ЛС'))
    throw error
  }
}
