import type { FeedbackSuggestion } from '@syrnike13/api-types'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { ArrowUpIcon, Loader2Icon } from '#/components/icons'
import {
  addFeedbackVote,
  removeFeedbackVote,
} from '#/features/api/feedback-api'
import { queryKeys } from '#/lib/api/query-keys'
import { cn } from '#/lib/utils'

export function FeedbackVoteButton({
  suggestion,
  token,
  compact = false,
}: {
  suggestion: FeedbackSuggestion
  token: string
  compact?: boolean
}) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () =>
      suggestion.voted
        ? removeFeedbackVote(token, suggestion._id)
        : addFeedbackVote(token, suggestion._id),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.feedback.detail(updated._id), updated)
      void queryClient.invalidateQueries({ queryKey: queryKeys.feedback.all })
    },
  })

  return (
    <button
      type="button"
      className={cn(
        'gradient-surface-input group/vote flex shrink-0 flex-col items-center justify-center rounded-md border text-xs font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
        compact ? 'size-14 gap-0.5' : 'h-[4.5rem] w-16 gap-1',
        suggestion.voted
          ? 'border-primary/45 bg-primary/10 text-primary'
          : 'border-border bg-muted/20 text-muted-foreground hover:border-primary/35 hover:bg-primary/5 hover:text-foreground',
      )}
      disabled={mutation.isPending}
      aria-pressed={suggestion.voted}
      aria-label={
        suggestion.voted
          ? `Снять голос, сейчас ${suggestion.vote_count}`
          : `Проголосовать, сейчас ${suggestion.vote_count}`
      }
      onClick={() => mutation.mutate()}
    >
      {mutation.isPending ? (
        <Loader2Icon className="size-4 animate-spin" aria-hidden />
      ) : (
        <ArrowUpIcon
          className={cn(
            'size-5 transition-transform group-hover/vote:-translate-y-0.5',
            suggestion.voted && 'text-primary',
          )}
          aria-hidden
        />
      )}
      <span>{suggestion.vote_count.toLocaleString('ru-RU')}</span>
    </button>
  )
}
