import type {
  FeedbackArea,
  FeedbackCategory,
  FeedbackPlatform,
  FeedbackProductStatus,
  FeedbackSort,
  FeedbackSuggestionPage,
} from '@syrnike13/api-types'
import { useDeferredValue, useEffect, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import {
  FEEDBACK_AREAS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_PLATFORMS,
  FEEDBACK_PRODUCT_STATUSES,
} from '#/components/feedback/feedback-meta'
import { FeedbackSuggestionRow } from '#/components/feedback/feedback-suggestion-row'
import {
  ChevronLeftIcon,
  InfoIcon,
  LightbulbIcon,
  PlusIcon,
  SearchIcon,
} from '#/components/icons'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { ScrollArea } from '#/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { useAuth } from '#/features/auth/auth-context'
import {
  fetchFeedbackSuggestions,
  fetchMyFeedbackSuggestions,
} from '#/features/api/feedback-api'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { queryKeys } from '#/lib/api/query-keys'
import { cn } from '#/lib/utils'

const PAGE_SIZE = 20

export type FeedbackViewMode = 'all' | 'mine'

function getFeedbackNextPageParam(lastPage: FeedbackSuggestionPage) {
  const next = lastPage.offset + lastPage.suggestions.length
  return next < lastPage.total ? next : undefined
}

export function FeedbackView({ initialMode = 'all' }: { initialMode?: FeedbackViewMode }) {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const prefix = useAppRoutePrefix()
  const token = auth.session?.token
  const viewerId = auth.user?._id
  const [mode, setMode] = useState<FeedbackViewMode>(initialMode)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [sort, setSort] = useState<FeedbackSort>('popular')
  const [category, setCategory] = useState<FeedbackCategory | 'all'>('all')
  const [area, setArea] = useState<FeedbackArea | 'all'>('all')
  const [platform, setPlatform] = useState<FeedbackPlatform | 'all'>('all')
  const [status, setStatus] = useState<FeedbackProductStatus | 'all'>('all')
  const showCatalogControls = mode === 'all'

  const listParams = {
    search: deferredSearch,
    sort,
    category,
    area,
    platform,
    status,
    limit: PAGE_SIZE,
  }

  const allQuery = useInfiniteQuery({
    queryKey: queryKeys.feedback.list(viewerId ?? 'pending-session', listParams),
    queryFn: ({ pageParam }) =>
      fetchFeedbackSuggestions(token!, { ...listParams, offset: pageParam }),
    initialPageParam: 0,
    enabled: Boolean(token && viewerId) && mode === 'all',
    // Moderators update statuses in a separate app, so cached list data must be
    // considered stale when the user returns to this view.
    staleTime: 0,
    getNextPageParam: getFeedbackNextPageParam,
  })

  const mineQuery = useInfiniteQuery({
    queryKey: queryKeys.feedback.mine(viewerId ?? 'pending-session'),
    queryFn: ({ pageParam }) =>
      fetchMyFeedbackSuggestions(token!, { offset: pageParam, limit: PAGE_SIZE }),
    initialPageParam: 0,
    enabled: Boolean(token && viewerId) && mode === 'mine',
    staleTime: 0,
    getNextPageParam: getFeedbackNextPageParam,
  })

  useEffect(() => {
    if (!token || !viewerId || !allQuery.isSuccess) return

    void queryClient.prefetchInfiniteQuery({
      queryKey: queryKeys.feedback.mine(viewerId),
      queryFn: ({ pageParam }) =>
        fetchMyFeedbackSuggestions(token, {
          offset: pageParam,
          limit: PAGE_SIZE,
        }),
      initialPageParam: 0,
      staleTime: 30_000,
      getNextPageParam: getFeedbackNextPageParam,
    })
  }, [allQuery.isSuccess, queryClient, token, viewerId])

  const activeQuery = mode === 'all' ? allQuery : mineQuery
  const suggestions = activeQuery.data?.pages.flatMap((page) => page.suggestions) ?? []

  return (
    <div className="gradient-surface-content flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="gradient-surface-chrome shrink-0 border-b border-shell-divider px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {prefix === '/m' ? (
              <Button variant="ghost" size="icon" asChild>
                <Link to="/m" search={{ tab: 'online' }} aria-label="На главную">
                  <ChevronLeftIcon className="size-5" />
                </Link>
              </Button>
            ) : null}
            <LightbulbIcon className="size-5 shrink-0 text-primary" aria-hidden />
            <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">Идеи</h1>
          </div>
          <Button className="shrink-0" asChild>
            <Link to={`${prefix}/feedback/new`}>
              <PlusIcon className="size-4" data-icon="inline-start" />
              <span className="hidden sm:inline">Добавить обращение</span>
              <span className="sm:hidden">Добавить</span>
            </Link>
          </Button>
        </div>

        {showCatalogControls ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <label className="relative min-w-56 flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Найти обращение"
                className="h-9 pl-9"
              />
            </label>

            <FeedbackFilterSelect
              ariaLabel="Сортировка"
              className="sm:w-36"
              value={sort}
              options={[
                { value: 'popular', label: 'Популярные' },
                { value: 'new', label: 'Новые' },
              ]}
              onValueChange={(value) => setSort(value as FeedbackSort)}
            />

            <FeedbackFilterSelect
              ariaLabel="Тип обращения"
              className="sm:w-36"
              value={category}
              options={[
                { value: 'all', label: 'Все типы' },
                ...FEEDBACK_CATEGORIES,
              ]}
              onValueChange={(value) => setCategory(value as FeedbackCategory | 'all')}
            />

            <FeedbackFilterSelect
              ariaLabel="Область"
              className="sm:w-48"
              value={area}
              options={[
                { value: 'all', label: 'Все области' },
                ...FEEDBACK_AREAS,
              ]}
              onValueChange={(value) => setArea(value as FeedbackArea | 'all')}
            />

            <FeedbackFilterSelect
              ariaLabel="Платформа"
              className="sm:w-40"
              value={platform}
              options={[
                { value: 'all', label: 'Все платформы' },
                ...FEEDBACK_PLATFORMS,
              ]}
              onValueChange={(value) => setPlatform(value as FeedbackPlatform | 'all')}
            />

            <FeedbackFilterSelect
              ariaLabel="Статус"
              className="sm:w-44"
              value={status}
              options={[
                { value: 'all', label: 'Все статусы' },
                ...FEEDBACK_PRODUCT_STATUSES,
              ]}
              onValueChange={(value) => setStatus(value as FeedbackProductStatus | 'all')}
            />
          </div>
        ) : null}

        <div className="mt-3 flex items-end gap-6">
          {(['all', 'mine'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={cn(
                'relative h-8 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground',
                mode === item && 'text-primary after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary',
              )}
              onClick={() => setMode(item)}
            >
              {item === 'all' ? 'Все обращения' : 'Мои обращения'}
            </button>
          ))}
        </div>
      </header>

      <div className="gradient-surface-raised flex shrink-0 items-start gap-2 border-b border-shell-divider bg-muted/10 px-4 py-2.5 text-xs leading-5 text-muted-foreground sm:px-6">
        <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>Голоса показывают интерес сообщества, но не являются обещанием реализации.</p>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-[80rem] px-2 py-2 sm:px-4 sm:py-3">
          {activeQuery.isLoading ? (
            <FeedbackListSkeleton />
          ) : activeQuery.isError ? (
            <FeedbackEmpty title="Не удалось загрузить обращения" description="Проверьте соединение и повторите позже." />
          ) : suggestions.length === 0 ? (
            <FeedbackEmpty
              title={mode === 'mine' ? 'У вас пока нет обращений' : 'Ничего не нашлось'}
              description={mode === 'mine' ? 'Добавьте обращение — после модерации оно появится в общем списке.' : 'Измените поиск или фильтры.'}
            />
          ) : (
            <div className="gradient-surface-card overflow-hidden rounded-lg border border-shell-divider bg-card/25">
              {suggestions.map((suggestion) => (
                <FeedbackSuggestionRow
                  key={suggestion._id}
                  suggestion={suggestion}
                  token={token!}
                />
              ))}
            </div>
          )}

          {activeQuery.hasNextPage ? (
            <div className="flex justify-center py-4">
              <Button
                variant="secondary"
                disabled={activeQuery.isFetchingNextPage}
                onClick={() => void activeQuery.fetchNextPage()}
              >
                {activeQuery.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
              </Button>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}

function FeedbackFilterSelect({
  ariaLabel,
  className,
  value,
  options,
  onValueChange,
}: {
  ariaLabel: string
  className?: string
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  onValueChange: (value: string) => void
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label={ariaLabel} className={cn('w-full', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        position="popper"
        side="bottom"
        align="start"
        sideOffset={0}
      >
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function FeedbackEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
      <LightbulbIcon className="size-9 text-muted-foreground/60" aria-hidden />
      <h2 className="mt-3 text-base font-semibold">{title}</h2>
      <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  )
}

function FeedbackListSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-shell-divider">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="flex items-center gap-4 border-b border-shell-divider p-3 last:border-b-0">
          <div className="h-[4.5rem] w-16 animate-pulse rounded-md bg-muted" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-4 w-2/5 animate-pulse rounded bg-muted" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  )
}
