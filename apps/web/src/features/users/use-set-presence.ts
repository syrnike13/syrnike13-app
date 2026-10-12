import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ManualPresence } from '@syrnike13/api-types'
import { Effect } from 'effect'
import { toast } from 'sonner'

import { updateCurrentUserEffect } from '#/features/api/users-api'
import { useAuth } from '#/features/auth/auth-context'
import { getUserPresence } from '#/lib/presence'
import { queryKeys } from '#/lib/api/query-keys'
import { syncStore } from '#/features/sync/sync-store'

export function useSetPresence() {
  const auth = useAuth()
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: (presence: ManualPresence) =>
      Effect.runPromise(
        Effect.gen(function*() {
          const token = auth.session?.token
          const user = auth.user
          if (!token || !user) {
            return yield* Effect.fail(new Error('Не авторизован'))
          }

          return yield* updateCurrentUserEffect(token, {
            status: {
              presence,
              text: user.status?.text ?? null,
            },
          })
        }),
      ),
    onSuccess: (updated) => {
      syncStore.upsertUser(updated)
      queryClient.setQueryData(queryKeys.auth.session, updated)
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Не удалось сменить статус',
      )
    },
  })

  return {
    presence: getUserPresence(auth.user),
    setPresence: mutation.mutateAsync,
    isPending: mutation.isPending,
  }
}
