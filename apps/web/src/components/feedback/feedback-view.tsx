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
import { FeedbackCreateDialog } from '#/components/feedback/feedback-create-dialog'
import { FeedbackSuggestionRow } from '#/components/feedback/feedback-suggestion-row'
import {
  CheckIcon,
  ChevronLeftIcon,
  FilterIcon,
  LightbulbIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
} from '#/components/icons'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
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

const MODE_TABS: { id: FeedbackViewMode; label: string }[] = [
  { id: 'all', label: 'Все обращения' },
  { id: 'mine', label: 'Мои обращения' },
]

function getFeedbackNextPageParam(lastPage: FeedbackSuggestionPage) {
  const next = lastPage.offset + lastPage.suggestions.length
  return next < lastPage.total ? next : undefined
}

export function FeedbackView({
  initialMode = 'all',
  createOpen,
  onCreateClose,
  onCreated,
}: {
  initialMode?: FeedbackViewMode
  createOpen?: boolean
  onCreateClose?: () => void
  onCreated?: () => void
}) {
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
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [internalCreateOpen, setInternalCreateOpen] = useState(false)
  const showCatalogControls = mode === 'all'

  const createControlled = createOpen !== undefined
  const isCreateOpen = createOpen ?? internalCreateOpen

  function handleCreateOpenChange(open: boolean) {
    if (createControlled) {
      if (!open) onCreateClose?.()
      return
    }
    setInternalCreateOpen(open)
  }

  function handleCreated() {
    if (createControlled) {
      onCreated?.()
      return
    }
    setMode('mine')
  }

  const activeFilterCount = [category, area, platform, status].filter(
    (value) => value !== 'all',
  ).length

  function resetFilters() {
    setCategory('all')
    setArea('all')
    setPlatform('all')
    setStatus('all')
  }

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
  const total = activeQuery.data?.pages[0]?.total

  return (
    <div className="theme-surface-content gradient-surface-content flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="gradient-surface-chrome shrink-0 border-b border-shell-divider px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          {prefix === '/m' ? (
            <Button variant="ghost" size="icon" className="size-8 shrink-0" asChild>
              <Link to="/m" search={{ tab: 'online' }} aria-label="На главную">
                <ChevronLeftIcon className="size-5" />
              </Link>
            </Button>
          ) : null}
          <div className="flex shrink-0 items-center gap-2">
            <LightbulbIcon className="size-5 shrink-0 text-primary" aria-hidden />
            <h1 className="text-sm font-semibold sm:text-base">Идеи</h1>
          </div>
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {MODE_TABS.map((item) => (
              <Button
                key={item.id}
                type="button"
                variant={mode === item.id ? 'secondary' : 'ghost'}
                size="sm"
                className={cn('shrink-0 rounded-md', mode === item.id && 'bg-muted')}
                onClick={() => setMode(item.id)}
              >
                {item.label}
              </Button>
            ))}
          </nav>
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => handleCreateOpenChange(true)}
          >
            <PlusIcon className="size-4" data-icon="inline-start" />
            <span className="hidden sm:inline">Добавить обращение</span>
            <span className="sm:hidden">Добавить</span>
          </Button>
        </div>

        {showCatalogControls ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="relative min-w-56 flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Найти обращение"
                className="h-9 bg-muted/30 pl-9"
              />
            </label>

            <Select value={sort} onValueChange={(value) => setSort(value as FeedbackSort)}>
              <SelectTrigger aria-label="Сортировка" size="sm" className="w-32 sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
                <SelectGroup>
                  <SelectItem value="popular">Популярные</SelectItem>
                  <SelectItem value="new">Новые</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>

            <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn(
                    'h-9 shrink-0',
                    filtersOpen && 'bg-accent text-accent-foreground',
                  )}
                >
                  <FilterIcon className="size-4" data-icon="inline-start" />
                  Фильтры
                  {activeFilterCount > 0 ? (
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                      {activeFilterCount}
                    </span>
                  ) : null}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="flex max-h-[70vh] w-[26rem] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0"
              >
                <ScrollArea className="min-h-0 flex-1">
                  <div className="grid gap-4 p-3 sm:grid-cols-2">
                    <FeedbackFilterGroup
                      label="Тип обращения"
                      value={category}
                      options={[
                        { value: 'all', label: 'Все типы' },
                        ...FEEDBACK_CATEGORIES,
                      ]}
                      onChange={(value) => setCategory(value as FeedbackCategory | 'all')}
                    />
                    <FeedbackFilterGroup
                      label="Статус"
                      value={status}
                      options={[
                        { value: 'all', label: 'Все статусы' },
                        ...FEEDBACK_PRODUCT_STATUSES,
                      ]}
                      onChange={(value) => setStatus(value as FeedbackProductStatus | 'all')}
                    />
                    <FeedbackFilterGroup
                      label="Область"
                      value={area}
                      options={[
                        { value: 'all', label: 'Все области' },
                        ...FEEDBACK_AREAS,
                      ]}
                      onChange={(value) => setArea(value as FeedbackArea | 'all')}
                    />
                    <FeedbackFilterGroup
                      label="Платформа"
                      value={platform}
                      options={[
                        { value: 'all', label: 'Все платформы' },
                        ...FEEDBACK_PLATFORMS,
                      ]}
                      onChange={(value) => setPlatform(value as FeedbackPlatform | 'all')}
                    />
                  </div>
                </ScrollArea>
                {activeFilterCount > 0 ? (
                  <div className="shrink-0 border-t border-shell-divider bg-muted/20 px-3 py-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full text-muted-foreground"
                      onClick={resetFilters}
                    >
                      <RotateCcwIcon className="size-3.5" data-icon="inline-start" />
                      Сбросить фильтры
                    </Button>
                  </div>
                ) : null}
              </PopoverContent>
            </Popover>
          </div>
        ) : null}
      </header>

      <div className="flex shrink-0 items-baseline justify-between gap-3 px-4 pt-3 pb-2 sm:px-6">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {mode === 'all' ? 'Все обращения' : 'Мои обращения'}
          {typeof total === 'number' ? ` — ${total.toLocaleString('ru-RU')}` : ''}
        </p>
        <p className="hidden text-xs text-muted-foreground sm:block">
          Голоса показывают интерес сообщества, но не являются обещанием реализации
        </p>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-[80rem] px-3 pb-3 sm:px-5">
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
            <div className="space-y-2">
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
                size="sm"
                disabled={activeQuery.isFetchingNextPage}
                onClick={() => void activeQuery.fetchNextPage()}
              >
                {activeQuery.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
              </Button>
            </div>
          ) : null}
        </div>
      </ScrollArea>

      <FeedbackCreateDialog
        open={isCreateOpen}
        onOpenChange={handleCreateOpenChange}
        onCreated={handleCreated}
      />
    </div>
  )
}

function FeedbackFilterGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <div role="group" aria-label={label}>
      <p className="px-2 pb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <div className="space-y-0.5">
        {options.map((option) => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              className={cn(
                'flex h-7 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                selected && 'bg-accent/60 text-foreground',
              )}
              onClick={() => onChange(option.value)}
            >
              <span className="min-w-0 flex-1 truncate text-left">{option.label}</span>
              {selected ? (
                <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
              ) : null}
            </button>
          )
        })}
      </div>
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
    <div className="space-y-2">
      {Array.from({ length: 5 }, (_, index) => (
        <div
          key={index}
          className="space-y-2.5 rounded-lg border border-shell-divider bg-card/25 px-3 py-2.5"
        >
          <div className="flex items-center gap-1.5">
            <div className="h-6 w-14 animate-pulse rounded-md bg-muted" />
            <div className="h-6 w-24 animate-pulse rounded-md bg-muted" />
            <div className="h-6 w-20 animate-pulse rounded-md bg-muted" />
          </div>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-3.5 w-2/5 animate-pulse rounded bg-muted" />
              <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-9 w-20 shrink-0 animate-pulse rounded-lg bg-muted" />
          </div>
        </div>
      ))}
    </div>
  )
}
