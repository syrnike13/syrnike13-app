import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'
import { toast } from 'sonner'

import { updateCurrentUserEffect } from '#/features/api/users-api'
import { useAuth } from '#/features/auth/auth-context'
import { queryKeys } from '#/lib/api/query-keys'
import { apiErrorMessage } from '#/lib/api/error-message'
import { syncStore } from '#/features/sync/sync-store'

export function useSetCustomStatus() {
  const t = useTranslations('users')
  const auth = useAuth()
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: (text: string) =>
      Effect.runPromise(
        Effect.gen(function*() {
          const token = auth.session?.token
          const user = auth.user
          if (!token || !user) {
            return yield* Effect.fail(new Error(t('notAuthorized')))
          }

          const trimmed = text.trim()
          return yield* updateCurrentUserEffect(token, {
            status: {
              text: trimmed.length ? trimmed : null,
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
        apiErrorMessage(error, t('statusUpdateError')),
      )
    },
  })

  return {
    setCustomStatus: mutation.mutateAsync,
    isPending: mutation.isPending,
  }
}
