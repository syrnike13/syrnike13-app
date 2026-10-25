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
import { useDeferredValue, useEffect, useId, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
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
import { Badge } from '@syrnike13/ui/primitives/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@syrnike13/ui/primitives/input-group'
import { Item, ItemActions, ItemContent } from '@syrnike13/ui/primitives/item'
import { Separator } from '@syrnike13/ui/primitives/separator'
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
import { shellColumnHeaderClass } from '#/components/layout/shell-chrome'
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
  const mode = initialMode
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [sort, setSort] = useState<FeedbackSort>('popular')
  const [category, setCategory] = useState<FeedbackCategory | 'all'>('all')
  const [area, setArea] = useState<FeedbackArea | 'all'>('all')
  const [platform, setPlatform] = useState<FeedbackPlatform | 'all'>('all')
  const [status, setStatus] = useState<FeedbackProductStatus | 'all'>('all')
  const [internalCreateOpen, setInternalCreateOpen] = useState(false)
  const showCatalogControls = mode === 'all'
  const headingId = useId()

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
    void navigate({ to: `${prefix}/feedback`, search: { view: 'mine' } })
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

  const filterGroups = [
    {
      label: t('filterType'),
      value: category,
      options: [
        { value: 'all', label: t('allTypes') },
        ...FEEDBACK_CATEGORIES.map((item) => ({ value: item.value, label: tm(item.labelKey) })),
      ],
      onChange: (value: string) => setCategory(value as FeedbackCategory | 'all'),
    },
    {
      label: t('filterStatus'),
      value: status,
      options: [
        { value: 'all', label: t('allStatuses') },
        ...FEEDBACK_PRODUCT_STATUSES.map((item) => ({ value: item.value, label: tm(item.labelKey) })),
      ],
      onChange: (value: string) => setStatus(value as FeedbackProductStatus | 'all'),
    },
    {
      label: t('filterArea'),
      value: area,
      options: [
        { value: 'all', label: t('allAreas') },
        ...FEEDBACK_AREAS.map((item) => ({ value: item.value, label: tm(item.labelKey) })),
      ],
      onChange: (value: string) => setArea(value as FeedbackArea | 'all'),
    },
    {
      label: t('filterPlatform'),
      value: platform,
      options: [
        { value: 'all', label: t('allPlatforms') },
        ...FEEDBACK_PLATFORMS.map((item) => ({ value: item.value, label: tm(item.labelKey) })),
      ],
      onChange: (value: string) => setPlatform(value as FeedbackPlatform | 'all'),
    },
  ]

  const listEmpty =
    activeQuery.isLoading || activeQuery.isError || suggestions.length === 0

  return (
    <div className="theme-surface-content gradient-surface-content flex min-h-0 min-w-0 flex-1 flex-col">
      <header className={cn(shellColumnHeaderClass, 'px-4')}>
        {prefix === '/m' ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('backHomeAria')}
            render={<Link to="/m" search={{ tab: 'online' }} />}
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
        ) : null}
        <LightbulbIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold">{t('title')}</h1>
        <div className="mx-2 flex h-6">
          <Separator orientation="vertical" />
        </div>
        <nav aria-label={t('title')} className="flex min-w-0 flex-1 items-center gap-2">
          {MODE_TABS.map((item) => (
            <Link
              key={item.id}
              to={`${prefix}/feedback`}
              search={{ view: item.id }}
              aria-current={mode === item.id ? 'page' : undefined}
              className={buttonVariants({
                variant: mode === item.id ? 'secondary' : 'ghost',
                size: 'sm',
              })}
            >
              {t(item.labelKey)}
            </Link>
          ))}
        </nav>
        <Button size="sm" onClick={() => handleCreateOpenChange(true)}>
          <PlusIcon data-icon="inline-start" />
          <span className="hidden sm:inline">{t('create')}</span>
          <span className="sm:hidden">{t('createShort')}</span>
        </Button>
      </header>

      {showCatalogControls ? (
        <div className="flex flex-wrap items-center gap-2 px-6 pt-4 pb-2">
          <InputGroup size="sm" className="min-w-56 flex-1">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('search')}
              aria-label={t('search')}
            />
          </InputGroup>

          <Select
            items={[
              { value: 'popular', label: t('sortPopular') },
              { value: 'new', label: t('sortNew') },
            ]}
            value={sort}
            onValueChange={(value) => {
              const decoded = Schema.decodeUnknownOption(ApiSchema.FeedbackSort)(value)
              if (Option.isSome(decoded)) setSort(decoded.value)
            }}
          >
            <SelectTrigger aria-label={t('sortAria')} size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="bottom" align="start">
              <SelectGroup>
                <SelectItem value="popular">{t('sortPopular')}</SelectItem>
                <SelectItem value="new">{t('sortNew')}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>

          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="outline" size="sm" />}>
              <FilterIcon data-icon="inline-start" />
              {t('filters')}
              {activeFilterCount > 0 ? <Badge>{activeFilterCount}</Badge> : null}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {filterGroups.map((group) => (
                <DropdownMenuSub key={group.label}>
                  <DropdownMenuSubTrigger
                    description={group.options.find((option) => option.value === group.value)?.label}
                  >
                    {group.label}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup value={group.value} onValueChange={group.onChange}>
                      {group.options.map((option) => (
                        <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick>
                          {option.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ))}
              {activeFilterCount > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={resetFilters}>
                    <RotateCcwIcon />
                    {t('resetFilters')}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}

      {listEmpty ? (
        activeQuery.isLoading ? (
          <FeedbackListSkeleton />
        ) : activeQuery.isError ? (
          <FeedbackEmpty title={t('loadErrorTitle')} description={t('loadErrorDescription')} />
        ) : (
          <FeedbackEmpty
            title={mode === 'mine' ? t('emptyMineTitle') : t('emptyAllTitle')}
            description={mode === 'mine' ? t('emptyMineDescription') : t('emptyAllDescription')}
          />
        )
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <section aria-labelledby={headingId} className="flex flex-col gap-2 px-6 pb-4">
            <div className="flex items-baseline justify-between gap-3 pt-2">
              <h2
                id={headingId}
                className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
              >
                {mode === 'all' ? t('modeAll') : t('modeMine')}
                {typeof total === 'number' ? ` — ${total.toLocaleString(locale)}` : ''}
              </h2>
              <p className="hidden text-xs text-muted-foreground sm:block">{t('votesNote')}</p>
            </div>
            <ul className="flex flex-col gap-2">
              {suggestions.map((suggestion) => (
                <FeedbackSuggestionRow key={suggestion._id} suggestion={suggestion} token={token!} />
              ))}
            </ul>
            {activeQuery.hasNextPage ? (
              <Button
                variant="secondary"
                size="sm"
                className="self-center"
                disabled={activeQuery.isFetchingNextPage}
                onClick={() => void activeQuery.fetchNextPage()}
              >
                {activeQuery.isFetchingNextPage ? t('loadingMore') : t('showMore')}
              </Button>
            ) : null}
          </section>
        </ScrollArea>
      )}

      <FeedbackCreateDialog
        open={isCreateOpen}
        onOpenChange={handleCreateOpenChange}
        onCreated={handleCreated}
      />
    </div>
  )
}

function FeedbackEmpty({ title, description }: { title: string; description: string }) {
  return (
    <Empty size="page">
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
    <ul className="flex flex-col gap-2 px-6 pt-4">
      {Array.from({ length: 5 }, (_, index) => (
        <Item key={index} variant="outline" render={<li />}>
          <ItemContent>
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-3/4" />
          </ItemContent>
          <ItemActions>
            <Skeleton className="h-8 w-16" />
          </ItemActions>
        </Item>
      ))}
    </ul>
  )
}
