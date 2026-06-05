import type { Message, User } from '@syrnike13/api-types'

import { searchChannelMessages } from '#/features/api/messages-api'
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

export async function searchServerMessages(
  token: string,
  state: SyncState,
  serverId: string,
  query: string,
  currentUserId: string | undefined,
  options: SearchServerMessagesOptions = {},
): Promise<{ hits: ServerMessageSearchHit[]; users: User[] }> {
  const limitPerChannel = options.limitPerChannel ?? 8
  const maxChannels = options.maxChannels ?? 24
  const channelIds = listServerTextChannelIds(state, serverId).slice(
    0,
    maxChannels,
  )

  if (channelIds.length === 0) {
    return { hits: [], users: [] }
  }

  const batches = await Promise.all(
    channelIds.map(async (channelId) => {
      try {
        const { messages, users } = await searchChannelMessages(
          token,
          channelId,
          query,
          limitPerChannel,
        )
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
      } catch {
        return { users: [], hits: [] }
      }
    }),
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
}
