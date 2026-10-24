import type { FeedbackSuggestion } from '@syrnike13/api-types'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'

import { ArrowUpIcon } from '#/components/icons'
import { Button } from '@syrnike13/ui/primitives/button'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import {
  addFeedbackVote,
  removeFeedbackVote,
} from '#/features/api/feedback-api'
import { useAuth } from '#/features/auth/auth-context'
import { queryKeys } from '#/lib/api/query-keys'

export function FeedbackVoteButton({
  suggestion,
  token,
}: {
  suggestion: FeedbackSuggestion
  token: string
}) {
  const t = useTranslations('feedback.vote')
  const { locale } = useLocale()
  const auth = useAuth()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () =>
      suggestion.voted
        ? removeFeedbackVote(token, suggestion._id)
        : addFeedbackVote(token, suggestion._id),
    onSuccess: (updated) => {
      if (auth.user?._id) {
        queryClient.setQueryData(
          queryKeys.feedback.detail(auth.user._id, updated._id),
          updated,
        )
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.feedback.all })
    },
  })

  return (
    <Button
      type="button"
      size="sm"
      variant={suggestion.voted ? 'default' : 'outline'}
      disabled={mutation.isPending}
      aria-pressed={suggestion.voted}
      aria-label={
        suggestion.voted
          ? t('removeAria', { count: suggestion.vote_count })
          : t('castAria', { count: suggestion.vote_count })
      }
      onClick={() => mutation.mutate()}
    >
      {mutation.isPending ? (
        <Spinner data-icon="inline-start" aria-hidden />
      ) : (
        <ArrowUpIcon data-icon="inline-start" aria-hidden />
      )}
      {suggestion.vote_count.toLocaleString(locale)}
    </Button>
  )
}
