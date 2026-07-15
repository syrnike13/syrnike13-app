import type { FeedbackSuggestion } from '@syrnike13/api-types'
import { RiArrowRightLine, RiGitMergeLine, RiUserLine } from '@remixicon/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { AdminEmpty, AdminPage, AdminSection } from '#/components/layout/page'
import { CheckIcon, Loader2Icon, XIcon } from '#/components/icons'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Label } from '#/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { Textarea } from '#/components/ui/textarea'
import { SearchField } from '#/components/search-field'
import { useAuth } from '#/features/auth/auth-context'
import {
  approveFeedback,
  fetchPendingFeedback,
  fetchPublishedFeedback,
  hideFeedback,
  mergeFeedback,
  rejectFeedback,
  searchPublishedFeedback,
  setFeedbackResponse,
  setFeedbackStatus,
} from '#/features/api/feedback-api'
import {
  FEEDBACK_PRODUCT_STATUSES,
  feedbackAreaLabel,
  feedbackCategoryLabel,
  feedbackPlatformLabel,
  feedbackProductStatusLabel,
  publicFeedbackStatus,
  type PublicFeedbackProductStatus,
} from '#/features/feedback/feedback-meta'
import {
  getFeedbackSimilarity,
  rankSimilarFeedback,
  type FeedbackSimilarity,
} from '#/features/feedback/feedback-similarity'
import { queryKeys } from '#/lib/api/query-keys'
import { cn } from '#/lib/utils'

type Mode = 'pending' | 'published'
type ModerationDialog =
  | { type: 'reject'; source: FeedbackSuggestion }
  | { type: 'merge'; source: FeedbackSuggestion; target: FeedbackSuggestion }
  | null
type CandidateSelection = {
  suggestion: FeedbackSuggestion
  similarity?: FeedbackSimilarity
}

const EMPTY_SUGGESTIONS: FeedbackSuggestion[] = []
const feedbackDateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

export function FeedbackModerationPage() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const token = auth.session?.token
  const [mode, setMode] = useState<Mode>('pending')
  const [selectedId, setSelectedId] = useState<string>()
  const [mergeTarget, setMergeTarget] = useState<FeedbackSuggestion | null>(null)
  const [duplicateSearch, setDuplicateSearch] = useState('')
  const [dialog, setDialog] = useState<ModerationDialog>(null)
  const [rejectionReason, setRejectionReason] = useState('')

  const pendingQuery = useQuery({
    queryKey: queryKeys.admin.feedbackPending,
    queryFn: () => fetchPendingFeedback(token!),
    enabled: Boolean(token),
  })
  const publishedQuery = useQuery({
    queryKey: queryKeys.admin.feedbackPublished,
    queryFn: () => fetchPublishedFeedback(token!),
    enabled: Boolean(token),
  })

  const activeQuery = mode === 'pending' ? pendingQuery : publishedQuery
  const suggestions = activeQuery.data?.suggestions ?? EMPTY_SUGGESTIONS
  const publishedSuggestions = publishedQuery.data?.suggestions ?? EMPTY_SUGGESTIONS
  const selectedSuggestion = useMemo(
    () => suggestions.find((item) => item._id === selectedId) ?? suggestions[0] ?? null,
    [selectedId, suggestions],
  )
  const normalizedDuplicateSearch = duplicateSearch.trim()
  const duplicateSearchQuery = useQuery({
    queryKey: [
      'admin',
      'feedback',
      'published-search',
      normalizedDuplicateSearch,
    ],
    queryFn: () => searchPublishedFeedback(token!, normalizedDuplicateSearch),
    enabled:
      Boolean(token) &&
      mode === 'pending' &&
      Boolean(selectedSuggestion) &&
      normalizedDuplicateSearch.length >= 2,
  })
  const similarFeedback = useMemo(
    () =>
      selectedSuggestion
        ? rankSimilarFeedback(selectedSuggestion, publishedSuggestions)
        : [],
    [publishedSuggestions, selectedSuggestion],
  )
  const manualSearchCandidates = useMemo(() => {
    if (!selectedSuggestion) return []

    const automaticIds = new Set(
      similarFeedback.map(({ suggestion }) => suggestion._id),
    )

    return (duplicateSearchQuery.data?.suggestions ?? EMPTY_SUGGESTIONS)
      .filter(
        (candidate) =>
          candidate.moderation_status === 'approved' &&
          candidate._id !== selectedSuggestion._id &&
          !automaticIds.has(candidate._id),
      )
      .map((suggestion) => ({
        suggestion,
        similarity: getFeedbackSimilarity(selectedSuggestion, suggestion) ?? undefined,
      }))
  }, [duplicateSearchQuery.data?.suggestions, selectedSuggestion, similarFeedback])

  function invalidate() {
    return queryClient.invalidateQueries({ queryKey: queryKeys.admin.feedback })
  }

  function resetMergeDraft() {
    setMergeTarget(null)
    setDuplicateSearch('')
  }

  function closeDialog() {
    setDialog(null)
    setRejectionReason('')
  }

  function selectMode(nextMode: Mode) {
    setMode(nextMode)
    setSelectedId(undefined)
    resetMergeDraft()
  }

  function selectSuggestion(suggestion: FeedbackSuggestion) {
    setSelectedId(suggestion._id)
    resetMergeDraft()
  }

  const approveMutation = useMutation({
    mutationFn: (id: string) => approveFeedback(token!, id),
    onSuccess: () => {
      toast.success('Обращение опубликовано')
      resetMergeDraft()
      void invalidate()
    },
    onError: () => toast.error('Не удалось одобрить обращение'),
  })
  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      rejectFeedback(token!, id, { reason }),
    onSuccess: () => {
      toast.success('Обращение отклонено')
      closeDialog()
      resetMergeDraft()
      void invalidate()
    },
    onError: () => toast.error('Не удалось отклонить обращение'),
  })
  const mergeMutation = useMutation({
    mutationFn: ({ source, target }: { source: FeedbackSuggestion; target: FeedbackSuggestion }) =>
      mergeFeedback(token!, source._id, { target_id: target._id }),
    onSuccess: () => {
      toast.success('Обращение объединено с выбранным')
      closeDialog()
      resetMergeDraft()
      void invalidate()
    },
    onError: () => toast.error('Не удалось объединить обращения'),
  })

  const pendingTotal = pendingQuery.data?.total ?? 0
  const publishedTotal = publishedQuery.data?.total ?? 0

  return (
    <AdminPage title="Обращения" innerClassName="max-w-[80rem]">
      <div className="flex flex-col gap-4">
        <FeedbackModeTabs
          mode={mode}
          pendingTotal={pendingTotal}
          publishedTotal={publishedTotal}
          onChange={selectMode}
        />

        {activeQuery.isLoading ? (
          <div className="flex min-h-80 items-center justify-center text-muted-foreground">
            <Loader2Icon className="size-5 animate-spin" aria-label="Загрузка обращений" />
          </div>
        ) : activeQuery.isError ? (
          <AdminEmpty>Не удалось загрузить обращения. Попробуйте обновить страницу.</AdminEmpty>
        ) : suggestions.length === 0 ? (
          <AdminEmpty>
            {mode === 'pending'
              ? 'Новых обращений на модерации нет.'
              : 'Опубликованных обращений пока нет.'}
          </AdminEmpty>
        ) : (
          <AdminSection className="min-h-[calc(100svh-9.5rem)]">
            <div className="grid h-full min-h-[calc(100svh-9.5rem)] lg:grid-cols-[minmax(19rem,0.82fr)_minmax(0,1.35fr)]">
              <FeedbackQueue
                mode={mode}
                total={mode === 'pending' ? pendingTotal : publishedTotal}
                suggestions={suggestions}
                selectedId={selectedSuggestion?._id}
                onSelect={selectSuggestion}
              />
              {selectedSuggestion ? (
                <FeedbackInspector
                  key={`${selectedSuggestion._id}:${selectedSuggestion.updated_at}`}
                  mode={mode}
                  suggestion={selectedSuggestion}
                  mergeTarget={mergeTarget}
                  similarFeedback={similarFeedback}
                  duplicateSearch={duplicateSearch}
                  manualSearchCandidates={manualSearchCandidates}
                  manualSearchIsLoading={duplicateSearchQuery.isFetching}
                  manualSearchIsError={duplicateSearchQuery.isError}
                  onDuplicateSearchChange={setDuplicateSearch}
                  onMergeTargetChange={setMergeTarget}
                  onApprove={() => approveMutation.mutate(selectedSuggestion._id)}
                  approving={
                    approveMutation.isPending &&
                    approveMutation.variables === selectedSuggestion._id
                  }
                  onReject={() => setDialog({ type: 'reject', source: selectedSuggestion })}
                  onMerge={() => {
                    if (!mergeTarget) return
                    setDialog({
                      type: 'merge',
                      source: selectedSuggestion,
                      target: mergeTarget,
                    })
                  }}
                  onRefresh={() => void invalidate()}
                />
              ) : null}
            </div>
          </AdminSection>
        )}
      </div>

      <Dialog open={Boolean(dialog)} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.type === 'merge' ? 'Объединить обращения?' : 'Отклонить обращение'}
            </DialogTitle>
            <DialogDescription>
              {dialog?.type === 'merge'
                ? 'Голоса исходного обращения будут перенесены в выбранное.'
                : dialog?.source.title}
            </DialogDescription>
          </DialogHeader>

          {dialog?.type === 'merge' ? (
            <MergeComparison source={dialog.source} target={dialog.target} compact />
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="feedback-rejection-reason">Причина для автора</Label>
              <Textarea
                id="feedback-rejection-reason"
                value={rejectionReason}
                placeholder="Автор увидит это пояснение"
                onChange={(event) => setRejectionReason(event.target.value)}
              />
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>
              Отмена
            </Button>
            <Button
              variant={dialog?.type === 'merge' ? 'default' : 'destructive'}
              disabled={
                dialog?.type === 'merge'
                  ? mergeMutation.isPending
                  : rejectMutation.isPending || !rejectionReason.trim()
              }
              onClick={() => {
                if (!dialog) return
                if (dialog.type === 'merge') {
                  mergeMutation.mutate({
                    source: dialog.source,
                    target: dialog.target,
                  })
                  return
                }

                rejectMutation.mutate({
                  id: dialog.source._id,
                  reason: rejectionReason.trim(),
                })
              }}
            >
              {dialog?.type === 'merge' ? 'Подтвердить объединение' : 'Отклонить'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}

function FeedbackModeTabs({
  mode,
  pendingTotal,
  publishedTotal,
  onChange,
}: {
  mode: Mode
  pendingTotal: number
  publishedTotal: number
  onChange: (mode: Mode) => void
}) {
  return (
    <div
      className="flex w-fit rounded-md border border-border/70 bg-card/40 p-0.5"
      role="tablist"
      aria-label="Разделы обращений"
    >
      <ModeTab active={mode === 'pending'} onClick={() => onChange('pending')}>
        Новые · {pendingTotal}
      </ModeTab>
      <ModeTab active={mode === 'published'} onClick={() => onChange('published')}>
        Опубликованные · {publishedTotal}
      </ModeTab>
    </div>
  )
}

function ModeTab({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={cn(
        'h-9 rounded px-4 text-[13px] font-medium transition-colors',
        active
          ? 'bg-secondary text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function FeedbackQueue({
  mode,
  total,
  suggestions,
  selectedId,
  onSelect,
}: {
  mode: Mode
  total: number
  suggestions: FeedbackSuggestion[]
  selectedId?: string
  onSelect: (suggestion: FeedbackSuggestion) => void
}) {
  return (
    <aside className="min-w-0 border-b border-border/60 lg:border-r lg:border-b-0">
      <div className="flex h-16 items-center justify-between border-b border-border/60 px-5">
        <h2 className="text-[15px] font-semibold">
          {mode === 'pending' ? 'Очередь модерации' : 'Опубликованные обращения'}
        </h2>
        <span className="text-[12px] text-muted-foreground">{total}</span>
      </div>
      <div className="divide-y divide-border/60">
        {suggestions.map((suggestion) => (
          <FeedbackQueueItem
            key={suggestion._id}
            mode={mode}
            suggestion={suggestion}
            selected={selectedId === suggestion._id}
            onSelect={() => onSelect(suggestion)}
          />
        ))}
      </div>
    </aside>
  )
}

function FeedbackQueueItem({
  mode,
  suggestion,
  selected,
  onSelect,
}: {
  mode: Mode
  suggestion: FeedbackSuggestion
  selected: boolean
  onSelect: () => void
}) {
  const statusLabel = feedbackProductStatusLabel(suggestion.status)

  return (
    <button
      type="button"
      className={cn(
        'flex w-full border-l-2 px-5 py-4 text-left transition-colors',
        selected
          ? 'border-primary bg-primary/10'
          : 'border-transparent hover:bg-muted/45',
      )}
      onClick={onSelect}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <FeedbackTag tone={suggestion.category === 'bug' ? 'danger' : 'success'}>
            {feedbackCategoryLabel(suggestion.category)}
          </FeedbackTag>
          {mode === 'published' && statusLabel ? (
            <FeedbackTag tone="status">{statusLabel}</FeedbackTag>
          ) : null}
          {suggestion.anonymous ? (
            <FeedbackTag tone="anonymous">Анонимно</FeedbackTag>
          ) : null}
        </div>
        <div className="mt-2 truncate text-[13px] font-semibold text-foreground">
          {suggestion.title}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <span>{feedbackAuthorTag(suggestion)}</span>
          <span aria-hidden>•</span>
          <span>{suggestion.platform ? feedbackPlatformLabel(suggestion.platform) : 'Все платформы'}</span>
          <span aria-hidden>•</span>
          <span>{formatFeedbackDate(suggestion.created_at)}</span>
        </div>
      </div>
    </button>
  )
}

function FeedbackInspector({
  mode,
  suggestion,
  mergeTarget,
  similarFeedback,
  duplicateSearch,
  manualSearchCandidates,
  manualSearchIsLoading,
  manualSearchIsError,
  onDuplicateSearchChange,
  onMergeTargetChange,
  onApprove,
  approving,
  onReject,
  onMerge,
  onRefresh,
}: {
  mode: Mode
  suggestion: FeedbackSuggestion
  mergeTarget: FeedbackSuggestion | null
  similarFeedback: CandidateSelection[]
  duplicateSearch: string
  manualSearchCandidates: CandidateSelection[]
  manualSearchIsLoading: boolean
  manualSearchIsError: boolean
  onDuplicateSearchChange: (value: string) => void
  onMergeTargetChange: (target: FeedbackSuggestion | null) => void
  onApprove: () => void
  approving: boolean
  onReject: () => void
  onMerge: () => void
  onRefresh: () => void
}) {
  const statusLabel = feedbackProductStatusLabel(suggestion.status)

  return (
    <section className="flex min-h-0 min-w-0 flex-col" aria-label="Инспектор обращения">
      <div className="flex flex-1 flex-col gap-6 p-5 sm:p-7">
        <header className="flex flex-col gap-3">
          <div className="text-[11px] font-semibold tracking-[0.12em] text-primary uppercase">
            {mode === 'pending' ? 'Новое обращение' : 'Опубликованное обращение'}
          </div>
          <h2 className="text-balance text-[23px] leading-tight font-semibold tracking-tight sm:text-[26px]">
            {suggestion.title}
          </h2>
          <div className="flex flex-wrap gap-2">
            <FeedbackTag tone={suggestion.category === 'bug' ? 'danger' : 'success'}>
              {feedbackCategoryLabel(suggestion.category)}
            </FeedbackTag>
            {suggestion.area ? (
              <FeedbackTag tone="area">{feedbackAreaLabel(suggestion.area)}</FeedbackTag>
            ) : null}
            <FeedbackTag tone="platform">
              {suggestion.platform ? feedbackPlatformLabel(suggestion.platform) : 'Все платформы'}
            </FeedbackTag>
            {mode === 'published' && statusLabel ? (
              <FeedbackTag tone="status">{statusLabel}</FeedbackTag>
            ) : null}
            {suggestion.anonymous ? (
              <FeedbackTag tone="anonymous">Анонимно для пользователей</FeedbackTag>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
            <RiUserLine className="size-4" aria-hidden />
            <span className="font-medium text-foreground">{feedbackAuthorTag(suggestion)}</span>
            <span aria-hidden>•</span>
            <span>{formatFeedbackDate(suggestion.created_at)}</span>
            <span aria-hidden>•</span>
            <span>{suggestion.vote_count} голосов</span>
          </div>
        </header>

        <div className="rounded-md border border-border/70 bg-muted/20 px-4 py-3 text-[14px] leading-6 whitespace-pre-wrap text-foreground">
          {suggestion.description}
        </div>

        {mode === 'pending' ? (
          <DuplicatePicker
            source={suggestion}
            automaticCandidates={similarFeedback}
            manualSearchCandidates={manualSearchCandidates}
            selectedTarget={mergeTarget}
            searchValue={duplicateSearch}
            searchIsLoading={manualSearchIsLoading}
            searchIsError={manualSearchIsError}
            onSearchChange={onDuplicateSearchChange}
            onTargetChange={onMergeTargetChange}
          />
        ) : (
          <PublishedFeedbackEditor
            suggestion={suggestion}
            onSaved={onRefresh}
          />
        )}
      </div>

      {mode === 'pending' ? (
        <div className="flex flex-col-reverse gap-2 border-t border-border/60 p-5 sm:flex-row sm:justify-end sm:p-6">
          <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={onReject}>
            <XIcon data-icon="inline-start" />
            Отклонить
          </Button>
          <Button variant="outline" disabled={!mergeTarget} onClick={onMerge}>
            <RiGitMergeLine data-icon="inline-start" />
            Объединить
          </Button>
          <Button disabled={approving} onClick={onApprove}>
            <CheckIcon data-icon="inline-start" />
            Одобрить
          </Button>
        </div>
      ) : null}
    </section>
  )
}

function DuplicatePicker({
  source,
  automaticCandidates,
  manualSearchCandidates,
  selectedTarget,
  searchValue,
  searchIsLoading,
  searchIsError,
  onSearchChange,
  onTargetChange,
}: {
  source: FeedbackSuggestion
  automaticCandidates: CandidateSelection[]
  manualSearchCandidates: CandidateSelection[]
  selectedTarget: FeedbackSuggestion | null
  searchValue: string
  searchIsLoading: boolean
  searchIsError: boolean
  onSearchChange: (value: string) => void
  onTargetChange: (target: FeedbackSuggestion | null) => void
}) {
  const hasSearch = searchValue.trim().length >= 2

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-[16px] font-semibold">Возможные дубли</h3>
        <p className="text-[12px] leading-5 text-muted-foreground">
          Подсказки по названию и описанию среди загруженных опубликованных обращений.
        </p>
      </div>

      <SearchField
        value={searchValue}
        aria-label="Найти опубликованное обращение для объединения"
        placeholder="Найти опубликованное обращение"
        onChange={(event) => onSearchChange(event.target.value)}
      />

      <CandidateGroup label="Подсказки">
        {automaticCandidates.length > 0 ? (
          automaticCandidates.map((candidate) => (
            <DuplicateCandidate
              key={candidate.suggestion._id}
              candidate={candidate}
              selected={selectedTarget?._id === candidate.suggestion._id}
              onSelect={() => onTargetChange(candidate.suggestion)}
            />
          ))
        ) : (
          <p className="rounded-md border border-dashed border-border/70 px-3 py-3 text-[12px] leading-5 text-muted-foreground">
            Совпадений не найдено — можно найти вручную.
          </p>
        )}
      </CandidateGroup>

      {hasSearch ? (
        <CandidateGroup label="Результаты поиска">
          {searchIsLoading ? (
            <div className="flex items-center gap-2 px-1 py-2 text-[12px] text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              Ищем опубликованные обращения…
            </div>
          ) : searchIsError ? (
            <p className="px-1 py-2 text-[12px] text-destructive">
              Не удалось выполнить поиск. Попробуйте ещё раз.
            </p>
          ) : manualSearchCandidates.length > 0 ? (
            manualSearchCandidates.map((candidate) => (
              <DuplicateCandidate
                key={candidate.suggestion._id}
                candidate={candidate}
                selected={selectedTarget?._id === candidate.suggestion._id}
                onSelect={() => onTargetChange(candidate.suggestion)}
              />
            ))
          ) : (
            <p className="px-1 py-2 text-[12px] text-muted-foreground">
              Ничего нового не найдено.
            </p>
          )}
        </CandidateGroup>
      ) : null}

      {selectedTarget ? (
        <MergeComparison source={source} target={selectedTarget} />
      ) : (
        <p className="rounded-md border border-dashed border-border/70 px-3 py-3 text-[12px] leading-5 text-muted-foreground">
          Выберите опубликованное обращение, чтобы посмотреть сравнение перед объединением.
        </p>
      )}
    </div>
  )
}

function CandidateGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  )
}

function DuplicateCandidate({
  candidate,
  selected,
  onSelect,
}: {
  candidate: CandidateSelection
  selected: boolean
  onSelect: () => void
}) {
  const statusLabel = feedbackProductStatusLabel(candidate.suggestion.status)

  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors',
        selected
          ? 'border-primary bg-primary/10'
          : 'border-border/70 bg-card/35 hover:bg-muted/35',
      )}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-primary bg-primary' : 'border-muted-foreground/70',
        )}
        aria-hidden
      >
        {selected ? <span className="size-1.5 rounded-full bg-primary-foreground" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="truncate text-[13px] font-semibold text-foreground">
            {candidate.suggestion.title}
          </span>
          {candidate.similarity ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              Совпадение {Math.round(candidate.similarity.score * 100)}%
            </span>
          ) : null}
        </span>
        <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
          <span>{candidate.suggestion.vote_count} голосов</span>
          {statusLabel ? <span>{statusLabel}</span> : null}
        </span>
        {candidate.similarity?.reasons.length ? (
          <span className="mt-2 flex flex-wrap gap-1.5">
            {candidate.similarity.reasons.map((reason) => (
              <FeedbackTag key={reason} tone="reason">
                {reason}
              </FeedbackTag>
            ))}
          </span>
        ) : null}
      </span>
    </button>
  )
}

function MergeComparison({
  source,
  target,
  compact = false,
}: {
  source: FeedbackSuggestion
  target: FeedbackSuggestion
  compact?: boolean
}) {
  return (
    <div className={cn('overflow-hidden rounded-md border border-border/70 bg-card/35', compact ? 'text-[12px]' : '')}>
      <div className="grid items-stretch gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <FeedbackComparisonItem label="Исходное" suggestion={source} />
        <div className="flex items-center justify-center text-muted-foreground">
          <RiArrowRightLine className="size-5" aria-label="Перенос голосов" />
        </div>
        <FeedbackComparisonItem label="Выбранное" suggestion={target} target />
      </div>
      <div className="border-t border-border/60 px-3 py-2.5 text-[12px] leading-5 text-muted-foreground">
        <span className="font-medium text-foreground">Внимание:</span> голоса из исходного обращения перейдут в выбранное.
      </div>
    </div>
  )
}

function FeedbackComparisonItem({
  label,
  suggestion,
  target = false,
}: {
  label: string
  suggestion: FeedbackSuggestion
  target?: boolean
}) {
  const statusLabel = feedbackProductStatusLabel(suggestion.status)

  return (
    <div className="min-w-0 rounded-md bg-muted/25 p-3">
      <div className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-1.5 line-clamp-2 text-[13px] font-semibold leading-5 text-foreground">
        {suggestion.title}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span>{suggestion.vote_count} голосов</span>
        <span>{feedbackCategoryLabel(suggestion.category)}</span>
        {suggestion.area ? <span>{feedbackAreaLabel(suggestion.area)}</span> : null}
        {suggestion.platform ? <span>{feedbackPlatformLabel(suggestion.platform)}</span> : null}
        {target && statusLabel ? <span>{statusLabel}</span> : null}
      </div>
      <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
        {suggestion.description}
      </p>
    </div>
  )
}

function PublishedFeedbackEditor({
  suggestion,
  onSaved,
}: {
  suggestion: FeedbackSuggestion
  onSaved: () => void
}) {
  const auth = useAuth()
  const token = auth.session?.token
  const [status, setStatus] = useState<PublicFeedbackProductStatus | ''>(() =>
    publicFeedbackStatus(suggestion.status),
  )
  const [response, setResponse] = useState(suggestion.team_response ?? '')

  const normalizedResponse = response.trim() || null
  const statusChanged = status !== '' && status !== suggestion.status
  const responseChanged = normalizedResponse !== (suggestion.team_response ?? null)
  const hasChanges = statusChanged || responseChanged

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!token) throw new Error('Missing authentication token')

      let updated = suggestion
      if (statusChanged) {
        updated = await setFeedbackStatus(token, suggestion._id, { status })
      }
      if (responseChanged) {
        updated = await setFeedbackResponse(token, suggestion._id, {
          response: normalizedResponse,
        })
      }
      return updated
    },
    onSuccess: () => {
      toast.success('Обращение обновлено')
      onSaved()
    },
    onError: () => toast.error('Не удалось сохранить изменения'),
  })
  const hideMutation = useMutation({
    mutationFn: async () => {
      if (!token) throw new Error('Missing authentication token')
      return hideFeedback(token, suggestion._id)
    },
    onSuccess: () => {
      toast.success('Обращение скрыто')
      onSaved()
    },
    onError: () => toast.error('Не удалось скрыть обращение'),
  })

  return (
    <div className="flex flex-col gap-4 border-t border-border/60 pt-5">
      <div>
        <h3 className="text-[16px] font-semibold">Публикация и ответ</h3>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          Статус и единый официальный ответ команды видны пользователям.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-[13rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`status-${suggestion._id}`}>Статус</Label>
          <Select
            value={status}
            onValueChange={(value) => setStatus(value as PublicFeedbackProductStatus)}
          >
            <SelectTrigger id={`status-${suggestion._id}`} className="w-full">
              <SelectValue placeholder="Статус не назначен" />
            </SelectTrigger>
            <SelectContent position="popper" side="bottom" align="start" sideOffset={0}>
              <SelectGroup>
                {FEEDBACK_PRODUCT_STATUSES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`response-${suggestion._id}`}>Ответ команды</Label>
          <Textarea
            id={`response-${suggestion._id}`}
            value={response}
            className="min-h-28"
            placeholder="Объясните решение или текущий прогресс"
            onChange={(event) => setResponse(event.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={hideMutation.isPending}
          onClick={() => hideMutation.mutate()}
        >
          Скрыть
        </Button>
        <Button disabled={saveMutation.isPending || !hasChanges} onClick={() => saveMutation.mutate()}>
          Сохранить
        </Button>
      </div>
    </div>
  )
}

function FeedbackTag({
  children,
  tone,
}: {
  children: ReactNode
  tone: 'danger' | 'success' | 'area' | 'platform' | 'status' | 'reason' | 'anonymous'
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] leading-4 font-medium',
        tone === 'danger' && 'border-destructive/55 bg-destructive/10 text-destructive',
        tone === 'success' && 'border-success/55 bg-success/10 text-success',
        tone === 'area' && 'border-primary/50 bg-primary/10 text-primary',
        tone === 'platform' && 'border-border/80 bg-secondary/50 text-muted-foreground',
        tone === 'status' && 'border-warning/55 bg-warning/10 text-warning',
        tone === 'reason' && 'border-primary/40 bg-primary/10 text-primary',
        tone === 'anonymous' && 'border-border/80 bg-muted/60 text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}

function feedbackAuthorTag(suggestion: FeedbackSuggestion) {
  const author = suggestion.author_username ?? suggestion.author
  return author ? `@${author}` : 'Неизвестный пользователь'
}

function formatFeedbackDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : feedbackDateFormatter.format(date)
}
