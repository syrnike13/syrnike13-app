import { channelUnreadMentionCount } from '@syrnike13/client/sync/selectors'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'

/** Unread mentions across all channels, optionally leaving one out (the open chat). */
export function useTotalMentions(exceptChannelId?: string) {
  return useSyncStore((state) => {
    let total = 0
    for (const [channelId, unread] of Object.entries(state.unreads)) {
      if (channelId !== exceptChannelId) total += channelUnreadMentionCount(unread)
    }
    return total
  })
}
