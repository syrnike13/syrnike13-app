import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'

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
import {
  CalendarIcon,
  ChevronLeftIcon,
  InfoIcon,
  MonitorIcon,
  TagIcon,
  UserIcon,
} from '#/components/icons'
import { buttonVariants } from '@syrnike13/ui/primitives/button'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import { fetchFeedbackSuggestion } from '#/features/api/feedback-api'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { useSyncStore } from '#/features/sync/sync-store'
import { queryKeys } from '#/lib/api/query-keys'
import { cn } from '#/lib/utils'

export function FeedbackDetailView({ feedbackId }: { feedbackId: string }) {
  const t = useTranslations('feedback.detail')
  const tm = useTranslations('feedback.meta')
  const { locale } = useLocale()
  const auth = useAuth()
  const prefix = useAppRoutePrefix()
  const token = auth.session?.token
  const viewerId = auth.user?._id
  const query = useQuery({
    queryKey: queryKeys.feedback.detail(viewerId ?? 'pending-session', feedbackId),
    queryFn: ({ signal }) =>
      fetchFeedbackSuggestion(token!, feedbackId, signal),
    enabled: Boolean(token && viewerId),
  })
  const author = useSyncStore((state) =>
    query.data?.author ? state.users[query.data.author] : undefined,
  )

  if (query.isLoading) {
    return (
      <div className="theme-surface-content gradient-surface-content flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t('loading')}
      </div>
    )
  }

  if (!query.data) {
    return (
      <div className="theme-surface-content gradient-surface-content flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t('notFound')}
      </div>
    )
  }

  const suggestion = query.data
  const approved = suggestion.moderation_status === 'approved'
  const authorUsername = suggestion.author_username ?? author?.username
  const authorLabel = suggestion.anonymous
    ? t('anonymous')
    : authorUsername
      ? `@${authorUsername}`
      : t('member')
  const date = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(suggestion.created_at))

  return (
    <div className="theme-surface-content gradient-surface-content flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="gradient-surface-chrome flex h-14 shrink-0 items-center gap-2 border-b border-shell-divider px-3 sm:px-5">
        <Link
          to={`${prefix}/feedback`}
          search={{ view: 'all' }}
          aria-label={t('backAria')}
          className={buttonVariants({ variant: 'ghost', size: 'icon' })}
        >
          <ChevronLeftIcon className="size-5" />
        </Link>
        <span className="truncate text-sm font-semibold">{t('title')}</span>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 sm:py-8">
          <article className="min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl">
                  {suggestion.title}
                </h1>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                  <FeedbackCategoryBadge category={suggestion.category} />
                  {approved ? (
                    <FeedbackProductStatus status={suggestion.status} />
                  ) : (
                    <FeedbackModerationStatus status={suggestion.moderation_status} />
                  )}
                  {suggestion.area ? (
                    <span className="inline-flex items-center gap-1">
                      <TagIcon className="size-3.5" />
                      {feedbackAreaLabel(suggestion.area, tm)}
                    </span>
                  ) : null}
                  {suggestion.platform ? (
                    <span className="inline-flex items-center gap-1">
                      <MonitorIcon className="size-3.5" />
                      {feedbackPlatformLabel(suggestion.platform, tm)}
                    </span>
                  ) : null}
                  <span className="inline-flex items-center gap-1"><UserIcon className="size-3.5" />{authorLabel}</span>
                  <span className="inline-flex items-center gap-1"><CalendarIcon className="size-3.5" />{date}</span>
                </div>
              </div>
            </div>

            {approved ? (
              <div className="mt-5">
                <FeedbackVoteButton suggestion={suggestion} token={token!} compact />
              </div>
            ) : null}

            <div className="mt-7 whitespace-pre-wrap text-base leading-7 text-foreground/90">
              {suggestion.description}
            </div>

            {suggestion.team_response ? (
              <section className="gradient-surface-raised mt-8 rounded-lg border border-primary/20 bg-primary/5 p-4 sm:p-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                  <InfoIcon className="size-4" aria-hidden />
                  {t('teamResponse')}
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground/85">
                  {suggestion.team_response}
                </p>
              </section>
            ) : null}

            {suggestion.rejection_reason ? (
              <section className="gradient-surface-raised mt-8 rounded-lg border border-destructive/25 bg-destructive/5 p-4 text-sm leading-6">
                <h2 className="font-semibold text-destructive">
                  {t('rejectionReason')}
                </h2>
                <p className="mt-1 text-muted-foreground">{suggestion.rejection_reason}</p>
              </section>
            ) : null}

            {suggestion.merged_into ? (
              <section className="gradient-surface-raised mt-8 rounded-lg border border-border bg-muted/20 p-4 text-sm leading-6">
                <h2 className="font-semibold">{t('mergedTitle')}</h2>
                {suggestion.merge_reason ? <p className="mt-1 text-muted-foreground">{suggestion.merge_reason}</p> : null}
                <Link
                  to={`${prefix}/feedback/$feedbackId`}
                  params={{ feedbackId: suggestion.merged_into }}
                  className={cn(
                    buttonVariants({ variant: 'link' }),
                    'mt-1 h-auto p-0',
                  )}
                >
                  {t('openMainIdea')}
                </Link>
              </section>
            ) : null}
          </article>
        </main>
      </ScrollArea>
    </div>
  )
}
