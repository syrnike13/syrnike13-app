import { useEffect } from 'react'
import type { Member, Role } from '@syrnike13/api-types'
import { Effect, Fiber } from 'effect'

import { fetchServerMemberEffect } from '#/features/api/servers-api'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'

const inFlight = new Map<
  string,
  {
    readonly id: symbol
    readonly fiber: Fiber.Fiber<Member | undefined, never>
  }
>()

type ServerMemberResponse =
  | Member
  | {
      member: Member
      roles: Record<string, Role>
    }

function responseMember(response: ServerMemberResponse): Member {
  return 'member' in response ? response.member : response
}

const loadServerMember = Effect.fn('sync.loadServerMember')(
  function*(token: string, serverId: string, userId: string) {
    const key = `${token}:${serverId}:${userId}`
    const existing = inFlight.get(key)
    if (existing) return yield* Fiber.join(existing.fiber)

    const id = Symbol(key)
    const fiber = Effect.runFork(
      Effect.gen(function*() {
        yield* Effect.yieldNow
        return yield* fetchServerMemberEffect(
          token,
          serverId,
          userId,
        ).pipe(
          Effect.map(responseMember),
          Effect.catch(() => Effect.succeed(undefined)),
        )
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
  },
)

export function useMutualServerMembersSync(
  userId: string,
  currentUserId: string | undefined,
  token: string | null | undefined,
  enabled = true,
) {
  const servers = useSyncStore((state) => state.servers)

  useEffect(() => {
    if (!enabled || !token || !currentUserId || userId === currentUserId) return

    const state = syncStore.getState()
    const fiber = Effect.runFork(
      Effect.all(
        Object.keys(servers).flatMap((serverId) => {
          if (state.members[`${serverId}:${userId}`]) return []
          return [
            loadServerMember(token, serverId, userId).pipe(
              Effect.flatMap((member) =>
                member
                  ? Effect.sync(() => syncStore.upsertMembers([member]))
                  : Effect.void,
              ),
              Effect.catch(() => Effect.void),
            ),
          ]
        }),
        { concurrency: 'unbounded' },
      ),
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [currentUserId, enabled, servers, token, userId])
}
