import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Presence } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { updateCurrentUser } from '#/features/api/users-api'
import { useAuth } from '#/features/auth/auth-context'
import { getUserPresence } from '#/lib/presence'
import { queryKeys } from '#/lib/api/query-keys'
import { syncStore } from '#/features/sync/sync-store'

export function useSetPresence() {
  const auth = useAuth()
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: async (presence: Presence) => {
      const token = auth.session?.token
      const user = auth.user
      if (!token || !user) {
        throw new Error('Не авторизован')
      }

      return updateCurrentUser(token, {
        status: {
          presence,
          text: user.status?.text ?? null,
        },
      })
    },
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
