import type { FeedbackSuggestion } from '@syrnike13/api-types'
import { Link } from '@tanstack/react-router'
import {
  useLocale,
  useTranslations,
  type AppLocale,
} from '@syrnike13/ui/i18n'

import { MonitorIcon, TagIcon } from '#/components/icons'
import { Badge } from '@syrnike13/ui/primitives/badge'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemOverlay,
  ItemTitle,
} from '@syrnike13/ui/primitives/item'
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
    <Item variant="outline" render={<li />}>
      <ItemOverlay
        render={
          <Link
            to={`${prefix}/feedback/$feedbackId`}
            params={{ feedbackId: suggestion._id }}
          />
        }
        aria-label={t('row.openAria', { title: suggestion.title })}
      />
      <ItemContent>
        <div className="flex flex-wrap items-center gap-1.5">
          <FeedbackCategoryBadge category={suggestion.category} />
          {publiclyApproved ? (
            <FeedbackProductStatus status={suggestion.status} />
          ) : (
            <FeedbackModerationStatus status={suggestion.moderation_status} />
          )}
          {suggestion.area ? (
            <Badge variant="outline">
              <TagIcon data-icon="inline-start" aria-hidden />
              {feedbackAreaLabel(suggestion.area, tm)}
            </Badge>
          ) : null}
          {suggestion.platform ? (
            <Badge variant="outline">
              <MonitorIcon data-icon="inline-start" aria-hidden />
              {feedbackPlatformLabel(suggestion.platform, tm)}
            </Badge>
          ) : null}
        </div>
        <ItemTitle>
          <h2>{suggestion.title}</h2>
        </ItemTitle>
        <ItemDescription>{suggestion.description}</ItemDescription>
        <p className="text-xs text-muted-foreground">
          {authorLabel} · {formatFeedbackDate(suggestion.created_at, locale)}
        </p>
      </ItemContent>
      <ItemActions>
        {publiclyApproved ? (
          <FeedbackVoteButton suggestion={suggestion} token={token} />
        ) : (
          <Badge variant="secondary">{t('votes', { count: suggestion.vote_count })}</Badge>
        )}
      </ItemActions>
    </Item>
  )
}
