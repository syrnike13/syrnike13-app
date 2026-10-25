import { Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from '@syrnike13/ui/i18n'

import { BadgeIcon } from '#/components/badge-icon'
import { MetaFlag } from '#/components/meta-flag'
import {
  AdminEmpty,
  AdminPage,
  AdminSection,
} from '#/components/layout/page'
import { ExternalLinkIcon, PlusIcon, SearchIcon } from '#/components/icons'
import { buttonVariants } from '@syrnike13/ui/primitives/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@syrnike13/ui/primitives/input-group'
import { Skeleton } from '@syrnike13/ui/primitives/skeleton'
import { Switch } from '@syrnike13/ui/primitives/switch'
import { useAuth } from '#/features/auth/auth-context'
import {
  fetchAdminActivities,
  updateAdminActivity,
  type AdminActivityApplication,
} from '#/features/api/activities-api'
import { queryKeys } from '#/lib/api/query-keys'
import { cn } from '#/lib/utils'

export function ActivitiesCatalogPage() {
  const t = useTranslations('activities.catalog')
  const auth = useAuth()
  const token = auth.session?.token
  const [query, setQuery] = useState('')

  const activitiesQuery = useQuery({
    queryKey: queryKeys.admin.activities,
    queryFn: ({ signal }) => fetchAdminActivities(token!, signal),
    enabled: Boolean(token),
  })

  const activities = useMemo(() => {
    const q = query.trim().toLowerCase()
    const items = [...(activitiesQuery.data ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    if (!q) return items
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) || item._id.includes(q),
    )
  }, [activitiesQuery.data, query])

  return (
    <AdminPage
      title={t('title')}
      actions={
        <Link to="/activities/new" className={cn(buttonVariants({ size: 'sm' }))}>
          <PlusIcon className="size-4" aria-hidden />
          {t('create')}
        </Link>
      }
    >
      <InputGroup className="mb-4 sm:max-w-xs">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchPlaceholder')}
        />
      </InputGroup>

      {activitiesQuery.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : activitiesQuery.isError ? (
        <AdminEmpty>{t('loadError')}</AdminEmpty>
      ) : activities.length === 0 ? (
        <AdminEmpty>
          {query.trim() ? (
            t('emptyFiltered')
          ) : (
            <span>
              {t('emptyCatalog')}{' '}
              <Link to="/activities/new" className="text-primary hover:underline">
                {t('createActivity')}
              </Link>
            </span>
          )}
        </AdminEmpty>
      ) : (
        <AdminSection>
          <ul>
            {activities.map((activity) => (
              <ActivityRow key={activity._id} activity={activity} />
            ))}
          </ul>
        </AdminSection>
      )}
    </AdminPage>
  )
}

function ActivityRow({ activity }: { activity: AdminActivityApplication }) {
  const t = useTranslations('activities.catalog')
  const auth = useAuth()
  const token = auth.session?.token
  const queryClient = useQueryClient()

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => {
      if (!token) return Promise.reject(new Error(t('toggleError')))
      return updateAdminActivity(token, activity._id, { enabled })
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<AdminActivityApplication[]>(
        queryKeys.admin.activities,
        (current = []) =>
          current.map((item) => (item._id === updated._id ? updated : item)),
      )
    },
    onError: () => {
    },
  })

  return (
    <li className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-0">
      <Link
        to="/activities/$activityId"
        params={{ activityId: activity._id }}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md transition-colors hover:text-primary"
      >
        <BadgeIcon badge={activity} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{activity.name}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">
            {activity._id}
          </div>
        </div>
      </Link>
      <a
        href={activity.activity_url}
        target="_blank"
        rel="noreferrer"
        className="hidden min-w-0 max-w-64 items-center gap-1 text-muted-foreground transition-colors hover:text-foreground md:flex"
      >
        <span className="truncate text-xs">{activity.activity_url}</span>
        <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden />
      </a>
      <div className="hidden items-center gap-3 sm:flex">
        {activity.first_party ? (
          <MetaFlag tone="accent">{t('firstParty')}</MetaFlag>
        ) : null}
        <span
          className="font-mono text-xs tabular-nums text-muted-foreground"
          title={t('participantsTitle')}
        >
          {t('participants', { count: activity.max_participants })}
        </span>
      </div>
      <Switch
        checked={activity.enabled}
        disabled={toggleMutation.isPending}
        aria-label={t('enabledAria', { name: activity.name })}
        onCheckedChange={(enabled) => toggleMutation.mutate(enabled)}
      />
    </li>
  )
}
