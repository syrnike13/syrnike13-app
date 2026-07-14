import { useEffect } from 'react'
import type { Member, MemberResponse } from '@syrnike13/api-types'

import { fetchServerMember } from '#/features/api/servers-api'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'

const inFlight = new Map<string, Promise<Member | undefined>>()

function responseMember(response: MemberResponse): Member | undefined {
  if (response.member) return response.member
  if (response._id && response.joined_at) return response as Member
  return undefined
}

function loadServerMember(token: string, serverId: string, userId: string) {
  const key = `${token}:${serverId}:${userId}`
  const existing = inFlight.get(key)
  if (existing) return existing

  const promise = fetchServerMember(token, serverId, userId)
    .then(responseMember)
    .catch(() => undefined)
    .finally(() => {
      inFlight.delete(key)
    })

  inFlight.set(key, promise)
  return promise
}

export function useMutualServerMembersSync(
  userId: string,
  currentUserId: string | undefined,
  token: string | null | undefined,
  enabled = true,
) {
  const servers = useSyncStore((state) => state.servers)

  useEffect(() => {
    if (!enabled || !token || !currentUserId || userId === currentUserId) return

    let cancelled = false
    const state = syncStore.getState()

    for (const serverId of Object.keys(servers)) {
      if (state.members[`${serverId}:${userId}`]) continue

      void loadServerMember(token, serverId, userId).then((member) => {
        if (cancelled || !member) return
        syncStore.upsertMembers([member])
      })
    }

    return () => {
      cancelled = true
    }
  }, [currentUserId, enabled, servers, token, userId])
}
