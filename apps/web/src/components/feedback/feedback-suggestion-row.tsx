import type { FeedbackSuggestion } from '@syrnike13/api-types'
import { Link } from '@tanstack/react-router'

import {
  CalendarIcon,
  ChevronRightIcon,
  TagIcon,
  UserIcon,
} from '#/components/icons'
import {
  feedbackCategoryLabel,
} from '#/components/feedback/feedback-meta'
import {
  FeedbackModerationStatus,
  FeedbackProductStatus,
} from '#/components/feedback/feedback-status'
import { FeedbackVoteButton } from '#/components/feedback/feedback-vote-button'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { useSyncStore } from '#/features/sync/sync-store'
import { cn } from '#/lib/utils'

function formatFeedbackDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
}

export function FeedbackSuggestionRow({
  suggestion,
  token,
}: {
  suggestion: FeedbackSuggestion
  token: string
}) {
  const prefix = useAppRoutePrefix()
  const author = useSyncStore((state) => state.users[suggestion.author])
  const authorLabel = author?.display_name ?? author?.username ?? 'Участник'
  const publiclyApproved = suggestion.moderation_status === 'approved'

  return (
    <article
      className={cn(
        'group/feedback-row relative grid grid-cols-[4rem_minmax(0,1fr)_1.5rem] items-center gap-3 border-b border-shell-divider px-3 py-3 transition-colors last:border-b-0 hover:bg-muted/20',
        'lg:grid-cols-[4rem_minmax(0,1fr)_13rem_11rem_1.5rem] lg:gap-4',
        suggestion.voted && 'before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary',
      )}
    >
      <FeedbackVoteButton suggestion={suggestion} token={token} />

      <div className="min-w-0 self-stretch py-0.5">
        <Link
          to={`${prefix}/feedback/$feedbackId`}
          params={{ feedbackId: suggestion._id }}
          className="block rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <h2 className="truncate text-sm font-semibold text-foreground sm:text-base">
            {suggestion.title}
          </h2>
          <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {suggestion.description}
          </p>
        </Link>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground lg:hidden">
          <span className="inline-flex items-center gap-1">
            <TagIcon className="size-3.5" aria-hidden />
            {feedbackCategoryLabel(suggestion.category)}
          </span>
          <span className="inline-flex items-center gap-1">
            <UserIcon className="size-3.5" aria-hidden />
            {authorLabel}
          </span>
        </div>
      </div>

      <div className="hidden min-w-0 space-y-1.5 text-xs text-muted-foreground lg:block">
        <span className="flex items-center gap-1.5">
          <TagIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {feedbackCategoryLabel(suggestion.category)}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <UserIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{authorLabel}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <CalendarIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{formatFeedbackDate(suggestion.created_at)}</span>
        </span>
      </div>

      <div className="hidden justify-self-start lg:block">
        {publiclyApproved ? (
          <FeedbackProductStatus status={suggestion.status} />
        ) : (
          <FeedbackModerationStatus status={suggestion.moderation_status} />
        )}
      </div>

      <Link
        to={`${prefix}/feedback/$feedbackId`}
        params={{ feedbackId: suggestion._id }}
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Открыть «${suggestion.title}»`}
      >
        <ChevronRightIcon className="size-5" aria-hidden />
      </Link>
    </article>
  )
}
