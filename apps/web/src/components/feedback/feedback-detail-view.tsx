import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

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
import { Button } from '#/components/ui/button'
import { ScrollArea } from '#/components/ui/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import { fetchFeedbackSuggestion } from '#/features/api/feedback-api'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { useSyncStore } from '#/features/sync/sync-store'
import { queryKeys } from '#/lib/api/query-keys'

export function FeedbackDetailView({ feedbackId }: { feedbackId: string }) {
  const auth = useAuth()
  const prefix = useAppRoutePrefix()
  const token = auth.session?.token
  const viewerId = auth.user?._id
  const query = useQuery({
    queryKey: queryKeys.feedback.detail(viewerId ?? 'pending-session', feedbackId),
    queryFn: () => fetchFeedbackSuggestion(token!, feedbackId),
    enabled: Boolean(token && viewerId),
  })
  const author = useSyncStore((state) =>
    query.data?.author ? state.users[query.data.author] : undefined,
  )

  if (query.isLoading) {
    return <div className="gradient-surface-content flex flex-1 items-center justify-center text-sm text-muted-foreground">Загружаем обращение…</div>
  }

  if (!query.data) {
    return <div className="gradient-surface-content flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">Обращение не найдено или недоступно.</div>
  }

  const suggestion = query.data
  const approved = suggestion.moderation_status === 'approved'
  const authorUsername = suggestion.author_username ?? author?.username
  const authorLabel = suggestion.anonymous
    ? 'Анонимно'
    : authorUsername
      ? `@${authorUsername}`
      : 'Участник'
  const date = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(suggestion.created_at))

  return (
    <div className="gradient-surface-content flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="gradient-surface-chrome flex h-14 shrink-0 items-center gap-2 border-b border-shell-divider px-3 sm:px-5">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`${prefix}/feedback`} search={{ view: 'all' }} aria-label="Назад к идеям">
            <ChevronLeftIcon className="size-5" />
          </Link>
        </Button>
        <span className="truncate text-sm font-semibold">Обращение</span>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6 sm:px-8 sm:py-8 lg:grid-cols-[5rem_minmax(0,1fr)]">
          <aside className="hidden lg:block">
            {approved ? <FeedbackVoteButton suggestion={suggestion} token={token!} /> : null}
          </aside>

          <article className="min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl">
                  {suggestion.title}
                </h1>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
                  <FeedbackCategoryBadge category={suggestion.category} />
                  {suggestion.area ? (
                    <span className="inline-flex items-center gap-1.5"><TagIcon className="size-3.5" />{feedbackAreaLabel(suggestion.area)}</span>
                  ) : null}
                  {suggestion.platform ? (
                    <span className="inline-flex items-center gap-1.5"><MonitorIcon className="size-3.5" />{feedbackPlatformLabel(suggestion.platform)}</span>
                  ) : null}
                  <span className="inline-flex items-center gap-1.5"><UserIcon className="size-3.5" />{authorLabel}</span>
                  <span className="inline-flex items-center gap-1.5"><CalendarIcon className="size-3.5" />{date}</span>
                </div>
              </div>
              {approved ? (
                <FeedbackProductStatus status={suggestion.status} />
              ) : (
                <FeedbackModerationStatus status={suggestion.moderation_status} />
              )}
            </div>

            {approved ? (
              <div className="mt-5 lg:hidden">
                <FeedbackVoteButton suggestion={suggestion} token={token!} compact />
              </div>
            ) : null}

            <div className="mt-7 whitespace-pre-wrap text-[15px] leading-7 text-foreground/90">
              {suggestion.description}
            </div>

            {suggestion.team_response ? (
              <section className="gradient-surface-raised mt-8 rounded-lg border border-primary/20 bg-primary/5 p-4 sm:p-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-primary">
                  <InfoIcon className="size-4" aria-hidden />
                  Ответ команды
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground/85">
                  {suggestion.team_response}
                </p>
              </section>
            ) : null}

            {suggestion.rejection_reason ? (
              <section className="gradient-surface-raised mt-8 rounded-lg border border-destructive/25 bg-destructive/5 p-4 text-sm leading-6">
                <h2 className="font-semibold text-destructive">Причина отклонения</h2>
                <p className="mt-1 text-muted-foreground">{suggestion.rejection_reason}</p>
              </section>
            ) : null}

            {suggestion.merged_into ? (
              <section className="gradient-surface-raised mt-8 rounded-lg border border-border bg-muted/20 p-4 text-sm leading-6">
                <h2 className="font-semibold">Предложение объединено</h2>
                {suggestion.merge_reason ? <p className="mt-1 text-muted-foreground">{suggestion.merge_reason}</p> : null}
                <Button variant="link" className="mt-1 h-auto p-0" asChild>
                  <Link to={`${prefix}/feedback/$feedbackId`} params={{ feedbackId: suggestion.merged_into }}>Открыть основную идею</Link>
                </Button>
              </section>
            ) : null}
          </article>
        </main>
      </ScrollArea>
    </div>
  )
}
