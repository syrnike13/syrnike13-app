import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import type { Badge } from '@syrnike13/api-types'
import { useQuery } from '@tanstack/react-query'

import { BadgeIcon } from '#/components/badge-icon'
import { MetaFlag } from '#/components/meta-flag'
import {
  AdminEmpty,
  AdminPage,
  AdminSection,
} from '#/components/layout/page'
import { PlusIcon } from '#/components/icons'
import { SearchField } from '#/components/search-field'
import { Button } from '#/components/ui/button'
import { useAuth } from '#/features/auth/auth-context'
import { fetchAdminBadges } from '#/features/api/admin-api'
import { queryKeys } from '#/lib/api/query-keys'
import { cn } from '#/lib/utils'

type BadgeFilter = 'all' | 'visible' | 'hidden' | 'premium'

const FILTERS: Array<{ value: BadgeFilter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'visible', label: 'Видимые' },
  { value: 'hidden', label: 'Скрытые' },
  { value: 'premium', label: 'Premium' },
]

export function BadgesCatalogPage() {
  const auth = useAuth()
  const token = auth.session?.token
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<BadgeFilter>('all')

  const badgesQuery = useQuery({
    queryKey: queryKeys.admin.badges,
    queryFn: () => fetchAdminBadges(token!),
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
      title="Бейджи"
      actions={
        <Button asChild size="sm">
          <Link to="/badges/new">
            <PlusIcon className="size-4" aria-hidden />
            Создать
          </Link>
        </Button>
      }
    >
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchField
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск"
          className="sm:max-w-xs"
        />
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
              className={cn(
                'h-8 rounded-md px-2.5 text-[12px] transition-colors',
                filter === item.value
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {badgesQuery.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-md bg-card/50" />
          ))}
        </div>
      ) : badges.length === 0 ? (
        <AdminEmpty>
          {filtered ? (
            'Ничего не найдено'
          ) : (
            <span>
              Каталог пуст.{' '}
              <Link to="/badges/new" className="text-primary hover:underline">
                Создать бейдж
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
  return (
    <li className="border-b border-border/50 last:border-0">
      <Link
        to="/badges/$badgeId"
        params={{ badgeId: badge._id }}
        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/40"
      >
        <BadgeIcon badge={badge} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{badge.name}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {badge.slug}
          </div>
        </div>
        <div className="hidden items-center gap-3 sm:flex">
          <MetaFlag tone={badge.visible ? 'ok' : 'muted'}>
            {badge.visible ? 'видимый' : 'скрытый'}
          </MetaFlag>
          {badge.premium ? <MetaFlag tone="accent">premium</MetaFlag> : null}
          <span className="w-8 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
            {badge.display_order}
          </span>
        </div>
      </Link>
    </li>
  )
}
