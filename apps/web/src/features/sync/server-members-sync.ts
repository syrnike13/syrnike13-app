import { useEffect } from 'react'
import { Effect, Fiber } from 'effect'

import { fetchServerMembersEffect } from '#/features/api/servers-api'
import { syncStore } from '#/features/sync/sync-store'

const loadedKeys = new Map<string, Set<string>>()
const inFlight = new Map<
  string,
  { readonly id: symbol; readonly fiber: Fiber.Fiber<void, unknown> }
>()

const loadServerMembers = Effect.fn('sync.loadServerMembers')(
  function*(token: string, serverId: string, key: string) {
    const { members, users } = yield* fetchServerMembersEffect(
      token,
      serverId,
    )
    yield* Effect.sync(() => {
      syncStore.upsertMembersAndUsers(members, users)
      loadedKeys.set(
        key,
        new Set(members.map((member) => member._id.user)),
      )
    })
  },
)

function syncKey(token: string, serverId: string) {
  return `${token}:${serverId}`
}

export function clearServerMembersSyncCache() {
  loadedKeys.clear()
  for (const operation of inFlight.values()) {
    Effect.runFork(Fiber.interrupt(operation.fiber))
  }
  inFlight.clear()
}

export const loadServerMembersIntoSyncStoreEffect = Effect.fn(
  'sync.loadServerMembersIntoStore',
)(function*(token: string, serverId: string) {
  const key = syncKey(token, serverId)
  const loadedMemberIds = loadedKeys.get(key)
  if (
    loadedMemberIds &&
    [...loadedMemberIds].every((userId) =>
      Boolean(syncStore.getState().members[`${serverId}:${userId}`]),
    )
  ) {
    return
  }

  const existing = inFlight.get(key)
  if (existing) return yield* Fiber.join(existing.fiber)

  const id = Symbol(key)
  const fiber = Effect.runFork(
    Effect.gen(function*() {
      yield* Effect.yieldNow
      yield* loadServerMembers(token, serverId, key)
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (inFlight.get(key)?.id === id) inFlight.delete(key)
        }),
      ),
    ),
  )

  inFlight.set(key, { id, fiber })
  return yield* Fiber.join(fiber)
})

export function loadServerMembersIntoSyncStore(
  token: string,
  serverId: string,
) {
  return Effect.runPromise(
    loadServerMembersIntoSyncStoreEffect(token, serverId),
  )
}

export function useServerMembersSync(
  serverId: string | null | undefined,
  token: string | null | undefined,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled || !serverId || !token) return

    const fiber = Effect.runFork(
      loadServerMembersIntoSyncStoreEffect(token, serverId).pipe(
        Effect.catch(() => Effect.void),
      ),
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [enabled, serverId, token])
}
