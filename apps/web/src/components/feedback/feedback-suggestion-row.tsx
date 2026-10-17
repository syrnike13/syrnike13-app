import type { FeedbackSuggestion } from '@syrnike13/api-types'
import { Link } from '@tanstack/react-router'
import {
  useLocale,
  useTranslations,
  type AppLocale,
} from '@syrnike13/ui/i18n'

import { MonitorIcon, TagIcon } from '#/components/icons'
import {
  feedbackAreaLabel,
  feedbackPlatformLabel,
} from '#/components/feedback/feedback-meta'
import {
  FeedbackCategoryBadge,
  FeedbackModerationStatus,
  FeedbackProductStatus,
} from '#/components/feedback/feedback-status'
import { FeedbackVoteButton } from '#/components/feedback/feedback-vote-button'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { useSyncStore } from '#/features/sync/sync-store'

const metaChipClass =
  'inline-flex min-h-6 shrink-0 items-center gap-1 rounded-md border border-border bg-muted/20 px-2 text-[0.6875rem] font-medium text-muted-foreground'

function formatFeedbackDate(value: string, locale: AppLocale) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
  }).format(date)
}

export function FeedbackSuggestionRow({
  suggestion,
  token,
}: {
  suggestion: FeedbackSuggestion
  token: string
}) {
  const t = useTranslations('feedback')
  const tm = useTranslations('feedback.meta')
  const { locale } = useLocale()
  const prefix = useAppRoutePrefix()
  const author = useSyncStore((state) =>
    suggestion.author ? state.users[suggestion.author] : undefined,
  )
  const authorUsername = suggestion.author_username ?? author?.username
  const authorLabel = suggestion.anonymous
    ? t('row.anonymous')
    : authorUsername
      ? `@${authorUsername}`
      : t('row.member')
  const publiclyApproved = suggestion.moderation_status === 'approved'

  return (
    <article className="group/feedback-row relative flex flex-col gap-2 rounded-lg border border-shell-divider bg-card/25 px-3 py-2.5 transition-colors hover:border-border hover:bg-muted/30">
      <Link
        to={`${prefix}/feedback/$feedbackId`}
        params={{ feedbackId: suggestion._id }}
        aria-label={t('row.openAria', { title: suggestion.title })}
        className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <FeedbackCategoryBadge category={suggestion.category} />
        {publiclyApproved ? (
          <FeedbackProductStatus status={suggestion.status} />
        ) : (
          <FeedbackModerationStatus status={suggestion.moderation_status} />
        )}
        {suggestion.area ? (
          <span className={metaChipClass}>
            <TagIcon className="size-3" aria-hidden />
            {feedbackAreaLabel(suggestion.area, tm)}
          </span>
        ) : null}
        {suggestion.platform ? (
          <span className={metaChipClass}>
            <MonitorIcon className="size-3" aria-hidden />
            {feedbackPlatformLabel(suggestion.platform, tm)}
          </span>
        ) : null}
        <span className="ml-auto hidden shrink-0 text-[0.6875rem] text-muted-foreground sm:block">
          {authorLabel} · {formatFeedbackDate(suggestion.created_at, locale)}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground transition-colors group-hover/feedback-row:text-primary">
            {suggestion.title}
          </h2>
          <p className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">
            {suggestion.description}
          </p>
        </div>

        <div className="relative z-10 shrink-0">
          {publiclyApproved ? (
            <FeedbackVoteButton suggestion={suggestion} token={token} compact />
          ) : (
            <span
              className="flex h-9 items-center rounded-lg border border-border bg-muted/20 px-3 text-xs font-semibold text-muted-foreground"
              aria-label={t('votes', { count: suggestion.vote_count })}
            >
              {t('votes', { count: suggestion.vote_count })}
            </span>
          )}
        </div>
      </div>
    </article>
  )
}
