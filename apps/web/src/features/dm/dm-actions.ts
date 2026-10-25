import type { Channel } from '@syrnike13/api-types'
import { Effect } from 'effect'

import { openDirectMessageEffect } from '#/features/api/users-api'
import { syncStore } from '#/features/sync/sync-store'

type NavigateToDmChannel = (channelId: string) => Promise<void> | void

export type DmActionDeps = {
  openDirectMessage: typeof openDirectMessageEffect
  upsertChannel: (channel: Channel) => void
  setSelectedServerId: (serverId: string | null) => void
}

const defaultDeps: DmActionDeps = {
  openDirectMessage: openDirectMessageEffect,
  upsertChannel: syncStore.upsertChannel,
  setSelectedServerId: syncStore.setSelectedServerId,
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

    return yield* action
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
