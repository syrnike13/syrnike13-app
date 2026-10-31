import type { User } from '@syrnike13/api-types'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'

function sameUsers(a: User[], b: User[]) {
  return a.length === b.length && a.every((user, index) => user === b[index])
}

/** Users the gateway reports in a voice channel, in join order. */
export function useVoiceChannelUsers(channelId: string) {
  return useSyncStore((state) => {
    const ids = Object.keys(state.voiceParticipants[channelId] ?? {})
    return ids.map((id) => state.users[id]).filter((user) => user !== undefined)
  }, sameUsers)
}
