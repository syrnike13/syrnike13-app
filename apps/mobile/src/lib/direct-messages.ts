import type { RelationshipStatus, User } from '@syrnike13/api-types'
import { openDirectMessageEffect } from '@syrnike13/client/api/users-api'
import { listUsersByRelationship } from '@syrnike13/client/sync/selectors'
import { syncStore, useSyncStore } from '@syrnike13/client/sync/sync-store'
import { Effect } from 'effect'
import { router } from 'expo-router'

import { useSession } from '../auth/session-context'

function sameUsers(a: User[], b: User[]) {
  return a.length === b.length && a.every((user, index) => user === b[index])
}

/** Users with this relationship to you, sorted by name; stable while unchanged. */
export function useUsersByRelationship(relationship: RelationshipStatus) {
  const { session } = useSession()
  return useSyncStore((state) => listUsersByRelationship(state, relationship, session.userId), sameUsers)
}

/** Opens (creating if needed) the DM with a user and shows it. */
export function useOpenDirectMessage() {
  const { session } = useSession()
  return (userId: string, { replace = false } = {}) =>
    Effect.runPromise(openDirectMessageEffect(session.token, userId)).then((channel) => {
      syncStore.upsertChannel(channel)
      const href = `/channel/${channel._id}` as const
      if (replace) router.replace(href)
      else router.push(href)
    })
}
