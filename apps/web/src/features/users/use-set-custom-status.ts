import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { updateCurrentUser } from '#/features/api/users-api'
import { useAuth } from '#/features/auth/auth-context'
import { queryKeys } from '#/lib/api/query-keys'
import { syncStore } from '#/features/sync/sync-store'

export function useSetCustomStatus() {
  const auth = useAuth()
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: async (text: string) => {
      const token = auth.session?.token
      const user = auth.user
      if (!token || !user) {
        throw new Error('Не авторизован')
      }

      const trimmed = text.trim()
      return updateCurrentUser(token, {
        status: {
          text: trimmed.length ? trimmed : null,
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
          : 'Не удалось обновить статус',
      )
    },
  })

  return {
    setCustomStatus: mutation.mutateAsync,
    isPending: mutation.isPending,
  }
}
