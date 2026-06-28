import { useQuery } from '@tanstack/react-query'
import type { User } from '@syrnike13/api-types'

import { useAuth } from '#/features/auth/auth-context'
import { fetchUser } from '#/features/api/users-api'
import { queryKeys } from '#/lib/api/query-keys'

/** Sync/WebSocket users omit badges; load them from REST when needed. */
export function useUserBadges(
  userId: string,
  fallbackBadges?: User['badges'],
) {
  const token = useAuth().session?.token
  const hasFallbackBadges = (fallbackBadges?.length ?? 0) > 0

  const badgesQuery = useQuery({
    queryKey: queryKeys.users.detail(userId),
    queryFn: () => fetchUser(token!, userId),
    enabled: Boolean(token) && !hasFallbackBadges,
    staleTime: 60_000,
    select: (user) => user.badges,
  })

  if (hasFallbackBadges) return fallbackBadges
  return badgesQuery.data ?? fallbackBadges
}
