import { useQuery } from '@tanstack/react-query'

import { useAuth } from '#/features/auth/auth-context'
import { fetchUserProfile } from '@syrnike13/client/api/users-api'
import { queryKeys } from '#/lib/api/query-keys'
import { userBannerUrl } from '#/lib/media'

/** Общий запрос профиля: баннер и «О себе» для поповера, панели и модалки. */
export function useUserProfileData(userId: string) {
  const token = useAuth().session?.token
  const profileQuery = useQuery({
    queryKey: queryKeys.users.profile(userId),
    queryFn: ({ signal }) => fetchUserProfile(token!, userId, signal),
    enabled: Boolean(token),
    staleTime: 60_000,
  })

  return {
    bio: profileQuery.data?.content?.trim() || null,
    colours: profileQuery.data?.colours ?? null,
    bannerUrl: userBannerUrl(profileQuery.data?.background, {
      animated: true,
    }),
    isPending: profileQuery.isPending,
  }
}
