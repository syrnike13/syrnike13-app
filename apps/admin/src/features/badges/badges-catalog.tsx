import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import type { Badge } from '@syrnike13/api-types'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from '@syrnike13/ui/i18n'

import { BadgeIcon } from '#/components/badge-icon'
import { MetaFlag } from '#/components/meta-flag'
import {
  AdminEmpty,
  AdminPage,
  AdminSection,
} from '#/components/layout/page'
import { PlusIcon, SearchIcon } from '#/components/icons'
import { buttonVariants } from '@syrnike13/ui/primitives/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@syrnike13/ui/primitives/input-group'
import { Skeleton } from '@syrnike13/ui/primitives/skeleton'
import { useAuth } from '#/features/auth/auth-context'
import { fetchAdminBadges } from '#/features/api/admin-api'
import { queryKeys } from '#/lib/api/query-keys'
import { cn } from '#/lib/utils'

type BadgeFilter = 'all' | 'visible' | 'hidden' | 'premium'

const FILTERS: Array<{ value: BadgeFilter; labelKey: string }> = [
  { value: 'all', labelKey: 'filters.all' },
  { value: 'visible', labelKey: 'filters.visible' },
  { value: 'hidden', labelKey: 'filters.hidden' },
  { value: 'premium', labelKey: 'filters.premium' },
]

export function BadgesCatalogPage() {
  const t = useTranslations('badges.catalog')
  const auth = useAuth()
  const token = auth.session?.token
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<BadgeFilter>('all')

  const badgesQuery = useQuery({
    queryKey: queryKeys.admin.badges,
    queryFn: ({ signal }) => fetchAdminBadges(token!, signal),
    enabled: Boolean(token),
  })

  const badges = useMemo(() => {
    const q = query.trim().toLowerCase()
    let items = [...(badgesQuery.data ?? [])].sort(
      (a, b) => a.display_order - b.display_order || a.slug.localeCompare(b.slug),
    )
    if (filter === 'visible') items = items.filter((b) => b.visible)
    if (filter === 'hidden') items = items.filter((b) => !b.visible)
    if (filter === 'premium') items = items.filter((b) => b.premium)
    if (q) {
      items = items.filter(
        (b) => b.name.toLowerCase().includes(q) || b.slug.toLowerCase().includes(q),
      )
    }
    return items
  }, [badgesQuery.data, filter, query])

  const filtered = Boolean(query.trim()) || filter !== 'all'

  return (
    <AdminPage
      title={t('title')}
      actions={
        <Link
          to="/badges/new"
          className={cn(buttonVariants({ size: 'sm' }))}
        >
          <PlusIcon className="size-4" aria-hidden />
          {t('create')}
        </Link>
      }
    >
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <InputGroup className="sm:max-w-xs">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
          />
        </InputGroup>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
              className={cn(
                'h-8 rounded-md px-2.5 text-xs transition-colors',
                filter === item.value
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {badgesQuery.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : badges.length === 0 ? (
        <AdminEmpty>
          {filtered ? (
            t('emptyFiltered')
          ) : (
            <span>
              {t('emptyCatalog')}{' '}
              <Link to="/badges/new" className="text-primary hover:underline">
                {t('createBadge')}
              </Link>
            </span>
          )}
        </AdminEmpty>
      ) : (
        <AdminSection>
          <ul>
            {badges.map((badge) => (
              <BadgeRow key={badge._id} badge={badge} />
            ))}
          </ul>
        </AdminSection>
      )}
    </AdminPage>
  )
}

function BadgeRow({ badge }: { badge: Badge }) {
  const t = useTranslations('badges.catalog')
  return (
    <li className="border-b border-border last:border-0">
      <Link
        to="/badges/$badgeId"
        params={{ badgeId: badge._id }}
        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/40"
      >
        <BadgeIcon badge={badge} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{badge.name}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">
            {badge.slug}
          </div>
        </div>
        <div className="hidden items-center gap-3 sm:flex">
          <MetaFlag tone={badge.visible ? 'ok' : 'muted'}>
            {badge.visible ? t('visible') : t('hidden')}
          </MetaFlag>
          {badge.premium ? (
            <MetaFlag tone="accent">{t('premium')}</MetaFlag>
          ) : null}
          <span className="w-8 text-right font-mono text-xs tabular-nums text-muted-foreground">
            {badge.display_order}
          </span>
        </div>
      </Link>
    </li>
  )
}
