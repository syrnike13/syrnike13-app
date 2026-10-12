import type { Channel } from '@syrnike13/api-types'
import { Effect } from 'effect'
import { toast } from 'sonner'

import { openDirectMessageEffect } from '#/features/api/users-api'
import { syncStore } from '#/features/sync/sync-store'

type NavigateToDmChannel = (channelId: string) => Promise<void> | void

export type DmActionDeps = {
  openDirectMessage: typeof openDirectMessageEffect
  upsertChannel: (channel: Channel) => void
  setSelectedServerId: (serverId: string | null) => void
  toastError: (message: string) => void
}

const defaultDeps: DmActionDeps = {
  openDirectMessage: openDirectMessageEffect,
  upsertChannel: syncStore.upsertChannel,
  setSelectedServerId: syncStore.setSelectedServerId,
  toastError: toast.error,
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

const openDirectMessageChannelEffect = Effect.fn('dm.openChannel')(
  function*(
    token: string,
    userId: string,
    navigateToChannel: NavigateToDmChannel,
    deps: DmActionDeps,
  ) {
    const action = Effect.gen(function*() {
      const channel = yield* deps.openDirectMessage(token, userId)
      yield* Effect.try({
        try: () => {
          deps.upsertChannel(channel)
          deps.setSelectedServerId(null)
        },
        catch: (cause) => cause,
      })
      yield* Effect.tryPromise({
        try: () => Promise.resolve(navigateToChannel(channel._id)),
        catch: (cause) => cause,
      })
      return channel
    })

    return yield* action.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          deps.toastError(errorMessage(error, 'Не удалось открыть ЛС'))
        }),
      ),
    )
  },
)

export function openDirectMessageChannel(
  token: string,
  userId: string,
  navigateToChannel: NavigateToDmChannel,
  deps: DmActionDeps = defaultDeps,
) {
  return openDirectMessageChannelEffect(
    token,
    userId,
    navigateToChannel,
    deps,
  )
}
