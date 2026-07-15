import type {
  FeedbackArea,
  FeedbackCategory,
  FeedbackPlatform,
  FeedbackProductStatus,
  FeedbackSort,
} from '@syrnike13/api-types'
import { useDeferredValue, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
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

export function FeedbackView({ initialMode = 'all' }: { initialMode?: FeedbackViewMode }) {
  const auth = useAuth()
  const prefix = useAppRoutePrefix()
  const token = auth.session?.token
  const [mode, setMode] = useState<FeedbackViewMode>(initialMode)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [sort, setSort] = useState<FeedbackSort>('popular')
  const [category, setCategory] = useState<FeedbackCategory | 'all'>('all')
  const [area, setArea] = useState<FeedbackArea | 'all'>('all')
  const [platform, setPlatform] = useState<FeedbackPlatform | 'all'>('all')
  const [status, setStatus] = useState<FeedbackProductStatus | 'all'>('all')

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
    queryKey: queryKeys.feedback.list(listParams),
    queryFn: ({ pageParam }) =>
      fetchFeedbackSuggestions(token!, { ...listParams, offset: pageParam }),
    initialPageParam: 0,
    enabled: Boolean(token) && mode === 'all',
    getNextPageParam: (lastPage) => {
      const next = lastPage.offset + lastPage.suggestions.length
      return next < lastPage.total ? next : undefined
    },
  })

  const mineQuery = useInfiniteQuery({
    queryKey: queryKeys.feedback.mine,
    queryFn: ({ pageParam }) =>
      fetchMyFeedbackSuggestions(token!, { offset: pageParam, limit: PAGE_SIZE }),
    initialPageParam: 0,
    enabled: Boolean(token) && mode === 'mine',
    getNextPageParam: (lastPage) => {
      const next = lastPage.offset + lastPage.suggestions.length
      return next < lastPage.total ? next : undefined
    },
  })

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

          <Select value={sort} onValueChange={(value) => setSort(value as FeedbackSort)}>
            <SelectTrigger className="w-full sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="popular">Популярные</SelectItem>
              <SelectItem value="new">Новые</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={category}
            onValueChange={(value) => setCategory(value as FeedbackCategory | 'all')}
          >
            <SelectTrigger className="w-full sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все типы</SelectItem>
              {FEEDBACK_CATEGORIES.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={area} onValueChange={(value) => setArea(value as FeedbackArea | 'all')}>
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все области</SelectItem>
              {FEEDBACK_AREAS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={platform}
            onValueChange={(value) => setPlatform(value as FeedbackPlatform | 'all')}
          >
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все платформы</SelectItem>
              {FEEDBACK_PLATFORMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={status}
            onValueChange={(value) => setStatus(value as FeedbackProductStatus | 'all')}
          >
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все статусы</SelectItem>
              {FEEDBACK_PRODUCT_STATUSES.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

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
