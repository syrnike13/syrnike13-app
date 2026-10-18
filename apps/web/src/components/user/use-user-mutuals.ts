import { useQuery } from '@tanstack/react-query'
import type { User } from '@syrnike13/api-types'

import { useAuth } from '#/features/auth/auth-context'
import { canViewUserProfile } from '#/features/authorization/authorization'
import { fetchUserMutual } from '#/features/api/users-api'
import { listMutualServers } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { queryKeys } from '#/lib/api/query-keys'

/**
 * Общие друзья и серверы с пользователем. Серверы берём из sync-стора:
 * там уже лежит полный список участников. Друзей отдаёт `/users/{id}/mutual`.
 */
export function useUserMutuals(
  userId: string,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options
  const auth = useAuth()
  const token = auth.session?.token
  const currentUserId = auth.user?._id
  const isSelf = userId === currentUserId
  const canView = canViewUserProfile(userId)
  const users = useSyncStore((state) => state.users)
  const mutualServers = useSyncStore((state) =>
    listMutualServers(state, userId, currentUserId),
  )

  const mutualQuery = useQuery({
    queryKey: queryKeys.users.mutual(userId),
    queryFn: ({ signal }) => fetchUserMutual(token!, userId, signal),
    enabled: Boolean(enabled && token && userId && !isSelf && canView),
    staleTime: 60_000,
  })

  const mutualFriendIds = mutualQuery.data?.users ?? []
  const mutualFriends = mutualFriendIds
    .map((id) => users[id])
    .filter((user): user is User => Boolean(user))

  return {
    mutualServers,
    mutualFriends,
    mutualFriendIds,
    mutualFriendsCount: mutualFriendIds.length,
    mutualServersCount: mutualServers.length,
    loading: mutualQuery.isLoading,
  }
}
