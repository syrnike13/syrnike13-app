import type { Message, User } from '@syrnike13/api-types'
import { Effect } from 'effect'

import { searchChannelMessagesEffect } from '#/features/api/messages-api'
import { channelLabelForMessage } from '#/features/command-palette/build-command-items'
import { listServerTextChannelIds } from '#/features/sync/selectors'
import type { SyncState } from '#/features/sync/types'

export type ServerMessageSearchHit = {
  message: Message
  channelId: string
  channelLabel: string
}

type SearchServerMessagesOptions = {
  limitPerChannel?: number
  maxChannels?: number
}

export const searchServerMessages = Effect.fn('messages.searchServer')(
  function*(
    token: string,
    state: SyncState,
    serverId: string,
    query: string,
    currentUserId: string | undefined,
    options: SearchServerMessagesOptions,
  ) {
    const limitPerChannel = options.limitPerChannel ?? 8
    const maxChannels = options.maxChannels ?? 24
    const channelIds = listServerTextChannelIds(state, serverId).slice(
      0,
      maxChannels,
    )

    if (channelIds.length === 0) {
      return { hits: [], users: [] }
    }

    const batches = yield* Effect.all(
      channelIds.map((channelId) =>
        searchChannelMessagesEffect(
          token,
          channelId,
          query,
          limitPerChannel,
        ).pipe(
          Effect.map(({ messages, users }) => {
            const channel = state.channels[channelId]
            const channelLabel = channel
              ? channelLabelForMessage(channel, state, currentUserId)
              : 'Канал'

            return {
              users,
              hits: messages.map((message) => ({
                message,
                channelId,
                channelLabel,
              })),
            }
          }),
          Effect.catch(() => Effect.succeed({ users: [], hits: [] })),
        ),
      ),
      { concurrency: 'unbounded' },
    )

    const usersById = new Map<string, User>()
    const hits: ServerMessageSearchHit[] = []

    for (const batch of batches) {
      for (const user of batch.users) {
        usersById.set(user._id, user)
      }
      hits.push(...batch.hits)
    }

    hits.sort((a, b) => b.message._id.localeCompare(a.message._id))

    return {
      hits: hits.slice(0, 50),
      users: [...usersById.values()],
    }
  },
)
