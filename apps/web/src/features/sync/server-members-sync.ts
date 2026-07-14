import { useEffect } from 'react'

import { fetchServerMembers } from '#/features/api/servers-api'
import { syncStore } from '#/features/sync/sync-store'

const loadedKeys = new Map<string, Set<string>>()
const inFlight = new Map<string, Promise<void>>()

function syncKey(token: string, serverId: string) {
  return `${token}:${serverId}`
}

export function clearServerMembersSyncCache() {
  loadedKeys.clear()
  inFlight.clear()
}

export function loadServerMembersIntoSyncStore(
  token: string,
  serverId: string,
) {
  const key = syncKey(token, serverId)
  const loadedMemberIds = loadedKeys.get(key)
  if (
    loadedMemberIds &&
    [...loadedMemberIds].every((userId) =>
      Boolean(syncStore.getState().members[`${serverId}:${userId}`]),
    )
  ) {
    return Promise.resolve()
  }

  const existing = inFlight.get(key)
  if (existing) return existing

  const promise = fetchServerMembers(token, serverId)
    .then(({ members, users }) => {
      syncStore.upsertMembersAndUsers(members, users)
      loadedKeys.set(
        key,
        new Set(members.map((member) => member._id.user)),
      )
    })
    .finally(() => {
      inFlight.delete(key)
    })

  inFlight.set(key, promise)
  return promise
}

export function useServerMembersSync(
  serverId: string | null | undefined,
  token: string | null | undefined,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled || !serverId || !token) return
    void loadServerMembersIntoSyncStore(token, serverId).catch(() => {})
  }, [enabled, serverId, token])
}
