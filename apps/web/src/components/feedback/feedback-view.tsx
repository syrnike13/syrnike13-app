import type {
  FeedbackArea,
  FeedbackCategory,
  FeedbackPlatform,
  FeedbackProductStatus,
  FeedbackSort,
  FeedbackSuggestionPage,
} from '@syrnike13/api-types'
import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Option, Schema } from 'effect'
import { useDeferredValue, useEffect, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'

import {
  FEEDBACK_AREAS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_PLATFORMS,
  FEEDBACK_PRODUCT_STATUSES,
} from '#/components/feedback/feedback-meta'
import { FeedbackCreateDialog } from '#/components/feedback/feedback-create-dialog'
import { FeedbackSuggestionRow } from '#/components/feedback/feedback-suggestion-row'
import {
  ChevronLeftIcon,
  FilterIcon,
  LightbulbIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
} from '#/components/icons'
import {
  Button,
  buttonVariants,
} from '@syrnike13/ui/primitives/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@syrnike13/ui/primitives/empty'
import { Input } from '@syrnike13/ui/primitives/input'
import {
  RadioGroup,
  RadioGroupItem,
} from '@syrnike13/ui/primitives/radio-group'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@syrnike13/ui/primitives/select'
import { Skeleton } from '@syrnike13/ui/primitives/skeleton'
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

const MODE_TABS: { id: FeedbackViewMode; labelKey: string }[] = [
  { id: 'all', labelKey: 'modeAll' },
  { id: 'mine', labelKey: 'modeMine' },
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
  const t = useTranslations('feedback.view')
  const tm = useTranslations('feedback.meta')
  const { locale } = useLocale()
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
    queryFn: ({ pageParam, signal }) =>
      fetchFeedbackSuggestions(
        token!,
        { ...listParams, offset: pageParam },
        signal,
      ),
    initialPageParam: 0,
    enabled: Boolean(token && viewerId) && mode === 'all',
    // Moderators update statuses in a separate app, so cached list data must be
    // considered stale when the user returns to this view.
    staleTime: 0,
    getNextPageParam: getFeedbackNextPageParam,
  })

  const mineQuery = useInfiniteQuery({
    queryKey: queryKeys.feedback.mine(viewerId ?? 'pending-session'),
    queryFn: ({ pageParam, signal }) =>
      fetchMyFeedbackSuggestions(
        token!,
        { offset: pageParam, limit: PAGE_SIZE },
        signal,
      ),
    initialPageParam: 0,
    enabled: Boolean(token && viewerId) && mode === 'mine',
    staleTime: 0,
    getNextPageParam: getFeedbackNextPageParam,
  })

  useEffect(() => {
    if (!token || !viewerId || !allQuery.isSuccess) return

    void queryClient.prefetchInfiniteQuery({
      queryKey: queryKeys.feedback.mine(viewerId),
      queryFn: ({ pageParam, signal }) =>
        fetchMyFeedbackSuggestions(
          token,
          {
            offset: pageParam,
            limit: PAGE_SIZE,
          },
          signal,
        ),
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
            <Link
              to="/m"
              search={{ tab: 'online' }}
              aria-label={t('backHomeAria')}
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'icon' }),
                'size-8 shrink-0',
              )}
            >
              <ChevronLeftIcon className="size-5" />
            </Link>
          ) : null}
          <div className="flex shrink-0 items-center gap-2">
            <LightbulbIcon className="size-5 shrink-0 text-primary" aria-hidden />
            <h1 className="text-sm font-semibold sm:text-base">{t('title')}</h1>
          </div>
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {MODE_TABS.map((item) => (
              <Button
                key={item.id}
                type="button"
                variant={mode === item.id ? 'secondary' : 'ghost'}
                size="sm"
                className="shrink-0"
                onClick={() => setMode(item.id)}
              >
                {t(item.labelKey)}
              </Button>
            ))}
          </nav>
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => handleCreateOpenChange(true)}
          >
            <PlusIcon className="size-4" data-icon="inline-start" />
            <span className="hidden sm:inline">{t('create')}</span>
            <span className="sm:hidden">{t('createShort')}</span>
          </Button>
        </div>

        {showCatalogControls ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="relative min-w-56 flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('search')}
                className="pl-9"
              />
            </label>

            <Select
              value={sort}
              onValueChange={(value) => {
                const decoded = Schema.decodeUnknownOption(
                  ApiSchema.FeedbackSort,
                )(value)
                if (Option.isSome(decoded)) setSort(decoded.value)
              }}
            >
              <SelectTrigger aria-label={t('sortAria')} size="sm" className="w-32 sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="bottom" align="start" sideOffset={4}>
                <SelectGroup>
                  <SelectItem value="popular">{t('sortPopular')}</SelectItem>
                  <SelectItem value="new">{t('sortNew')}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>

            <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
              <PopoverTrigger render={<Button
                  type="button"
                  variant={filtersOpen ? 'secondary' : 'outline'}
                  size="sm"
                  className="h-9 shrink-0" />}>
                  <FilterIcon className="size-4" data-icon="inline-start" />
                  {t('filters')}
                  {activeFilterCount > 0 ? (
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                      {activeFilterCount}
                    </span>
                  ) : null}
                </PopoverTrigger>
              <PopoverContent
                align="end"
                className="flex max-h-feedback w-104 max-w-viewport-inset flex-col gap-0 overflow-hidden p-0"
              >
                <ScrollArea className="min-h-0 flex-1">
                  <div className="grid gap-4 p-3 sm:grid-cols-2">
                    <FeedbackFilterGroup
                      label={t('filterType')}
                      value={category}
                      options={[
                        { value: 'all', label: t('allTypes') },
                        ...FEEDBACK_CATEGORIES.map((item) => ({
                          value: item.value,
                          label: tm(item.labelKey),
                        })),
                      ]}
                      onChange={setCategory}
                    />
                    <FeedbackFilterGroup
                      label={t('filterStatus')}
                      value={status}
                      options={[
                        { value: 'all', label: t('allStatuses') },
                        ...FEEDBACK_PRODUCT_STATUSES.map((item) => ({
                          value: item.value,
                          label: tm(item.labelKey),
                        })),
                      ]}
                      onChange={setStatus}
                    />
                    <FeedbackFilterGroup
                      label={t('filterArea')}
                      value={area}
                      options={[
                        { value: 'all', label: t('allAreas') },
                        ...FEEDBACK_AREAS.map((item) => ({
                          value: item.value,
                          label: tm(item.labelKey),
                        })),
                      ]}
                      onChange={setArea}
                    />
                    <FeedbackFilterGroup
                      label={t('filterPlatform')}
                      value={platform}
                      options={[
                        { value: 'all', label: t('allPlatforms') },
                        ...FEEDBACK_PLATFORMS.map((item) => ({
                          value: item.value,
                          label: tm(item.labelKey),
                        })),
                      ]}
                      onChange={setPlatform}
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
                      {t('resetFilters')}
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
          {mode === 'all' ? t('modeAll') : t('modeMine')}
          {typeof total === 'number' ? ` — ${total.toLocaleString(locale)}` : ''}
        </p>
        <p className="hidden text-xs text-muted-foreground sm:block">
          {t('votesNote')}
        </p>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-320 px-3 pb-3 sm:px-5">
          {activeQuery.isLoading ? (
            <FeedbackListSkeleton />
          ) : activeQuery.isError ? (
            <FeedbackEmpty
              title={t('loadErrorTitle')}
              description={t('loadErrorDescription')}
            />
          ) : suggestions.length === 0 ? (
            <FeedbackEmpty
              title={
                mode === 'mine' ? t('emptyMineTitle') : t('emptyAllTitle')
              }
              description={
                mode === 'mine'
                  ? t('emptyMineDescription')
                  : t('emptyAllDescription')
              }
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
                {activeQuery.isFetchingNextPage ? t('loadingMore') : t('showMore')}
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

function FeedbackFilterGroup<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: Value
  options: ReadonlyArray<{ value: Value; label: string }>
  onChange: (value: Value) => void
}) {
  return (
    <div>
      <p className="px-2 pb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <RadioGroup
        aria-label={label}
        value={value}
        onValueChange={(next) => onChange(next as Value)}
        className="gap-0.5"
      >
        {options.map((option) => {
          const selected = option.value === value
          return (
            <label
              key={option.value}
              className={cn(
                'flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                selected && 'bg-accent/60 text-foreground',
              )}
            >
              <RadioGroupItem
                value={option.value}
                aria-label={option.label}
              />
              <span className="min-w-0 flex-1 truncate text-left">
                {option.label}
              </span>
            </label>
          )
        })}
      </RadioGroup>
    </div>
  )
}

function FeedbackEmpty({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="min-h-64">
      <EmptyMedia variant="icon">
        <LightbulbIcon aria-hidden />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
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
            <Skeleton className="h-6 w-14" />
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-6 w-20" />
          </div>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-3/4" />
            </div>
            <Skeleton className="h-9 w-20 shrink-0" />
          </div>
        </div>
      ))}
    </div>
  )
}
