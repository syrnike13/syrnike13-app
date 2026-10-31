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
import { FeedbackAttachments } from '#/components/feedback/feedback-attachments'
import {
  FeedbackPeripheralsSummary,
  FeedbackSystemSummary,
} from '#/components/feedback/feedback-system'
import {
  CalendarIcon,
  ChevronLeftIcon,
  InfoIcon,
  LightbulbIcon,
  MonitorIcon,
  TagIcon,
  UserIcon,
} from '#/components/icons'
import { Alert, AlertDescription, AlertTitle } from '@syrnike13/ui/primitives/alert'
import { Badge } from '@syrnike13/ui/primitives/badge'
import { Button } from '@syrnike13/ui/primitives/button'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { useAuth } from '#/features/auth/auth-context'
import { fetchFeedbackSuggestion } from '#/features/api/feedback-api'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { useSyncStore } from '@syrnike13/client/sync/sync-store'
import { queryKeys } from '#/lib/api/query-keys'
import { shellColumnHeaderClass } from '#/components/layout/shell-chrome'
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
      <div className="theme-surface-content gradient-surface-content flex flex-1 items-center justify-center">
        <Spinner aria-label={t('loading')} />
      </div>
    )
  }

  if (!query.data) {
    return (
      <div className="theme-surface-content gradient-surface-content flex flex-1 items-center justify-center px-6">
        <Empty size="page">
          <EmptyDescription>{t('notFound')}</EmptyDescription>
        </Empty>
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
      <header className={cn(shellColumnHeaderClass, 'px-4')}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('backAria')}
          render={<Link to={`${prefix}/feedback`} search={{ view: 'all' }} />}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
        <LightbulbIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate text-base font-semibold">{t('title')}</span>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <article className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-6 px-6 py-8">
          <div className="flex flex-col gap-3">
            <h1 className="text-2xl leading-tight font-bold tracking-tight">{suggestion.title}</h1>
            <div className="flex flex-wrap items-center gap-1.5">
              <FeedbackCategoryBadge category={suggestion.category} />
              {approved ? (
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
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <UserIcon className="size-4" aria-hidden />
                {authorLabel}
              </span>
              <span className="inline-flex items-center gap-1">
                <CalendarIcon className="size-4" aria-hidden />
                {date}
              </span>
            </p>
            {approved ? (
              <div>
                <FeedbackVoteButton suggestion={suggestion} token={token!} />
              </div>
            ) : null}
          </div>

          <p className="text-base leading-7 whitespace-pre-wrap">{suggestion.description}</p>

          {suggestion.attachments?.length ? (
            <FeedbackAttachments attachments={suggestion.attachments} />
          ) : null}

          {suggestion.system || suggestion.peripherals?.length ? (
            <section className="space-y-3">
              {suggestion.system ? (
                <div className="space-y-1">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    {t('systemTitle')}
                  </h3>
                  <FeedbackSystemSummary system={suggestion.system} />
                </div>
              ) : null}
              {suggestion.peripherals?.length ? (
                <div className="space-y-1">
                  <h3 className="text-sm font-medium text-muted-foreground">
                    {t('peripheralsTitle')}
                  </h3>
                  <FeedbackPeripheralsSummary
                    peripherals={suggestion.peripherals}
                  />
                </div>
              ) : null}
            </section>
          ) : null}

          {suggestion.team_response ? (
            <Alert>
              <InfoIcon aria-hidden />
              <AlertTitle>{t('teamResponse')}</AlertTitle>
              <AlertDescription className="whitespace-pre-wrap">{suggestion.team_response}</AlertDescription>
            </Alert>
          ) : null}

          {suggestion.rejection_reason ? (
            <Alert variant="destructive">
              <AlertTitle>{t('rejectionReason')}</AlertTitle>
              <AlertDescription>{suggestion.rejection_reason}</AlertDescription>
            </Alert>
          ) : null}

          {suggestion.merged_into ? (
            <Alert>
              <AlertTitle>{t('mergedTitle')}</AlertTitle>
              <AlertDescription>
                {suggestion.merge_reason ? <p>{suggestion.merge_reason}</p> : null}
                <Link
                  to={`${prefix}/feedback/$feedbackId`}
                  params={{ feedbackId: suggestion.merged_into }}
                >
                  {t('openMainIdea')}
                </Link>
              </AlertDescription>
            </Alert>
          ) : null}
        </article>
      </ScrollArea>
    </div>
  )
}
