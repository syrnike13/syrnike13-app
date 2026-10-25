import type { UserPrivacy } from '@syrnike13/api-types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Effect } from 'effect'
import { useCallback } from 'react'

import { fetchPrivacyEffect, updatePrivacyEffect } from '#/features/api/users-api'
import { useAuth } from '#/features/auth/auth-context'

export const PRIVACY_QUERY_KEY = ['users', 'privacy'] as const

export const DEFAULT_PRIVACY: Required<UserPrivacy> = {
  dm_restricted_servers: [],
  restrict_dms_in_new_servers: false,
  friend_requests: {
    everyone: true,
    friends_of_friends: true,
    server_members: true,
  },
}

/** Who can reach the current user. Changes are saved immediately, like Discord. */
export function usePrivacy() {
  const auth = useAuth()
  const token = auth.session?.token
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: PRIVACY_QUERY_KEY,
    queryFn: ({ signal }) =>
      Effect.runPromise(fetchPrivacyEffect(token!), { signal }),
    enabled: Boolean(token),
  })

  const privacy: Required<UserPrivacy> = { ...DEFAULT_PRIVACY, ...query.data }

  const update = useCallback(
    (next: Required<UserPrivacy>) => {
      if (!token) return
      queryClient.setQueryData(PRIVACY_QUERY_KEY, next)
      void Effect.runPromise(
        updatePrivacyEffect(token, next).pipe(
          Effect.tap((saved) =>
            Effect.sync(() => queryClient.setQueryData(PRIVACY_QUERY_KEY, saved)),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              console.error('[privacy] save failed', error)
              void queryClient.invalidateQueries({ queryKey: PRIVACY_QUERY_KEY })
            }),
          ),
        ),
      )
    },
    [queryClient, token],
  )

  return { privacy, loaded: query.isSuccess, update }
}
