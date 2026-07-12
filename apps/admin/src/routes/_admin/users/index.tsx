import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Badge, User } from '@syrnike13/api-types'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

import { BadgeIcon } from '#/components/badge-icon'
import {
  AdminEmpty,
  AdminPage,
  AdminSection,
  AdminSectionHeader,
} from '#/components/layout/page'
import { Loader2Icon, PlusIcon, XIcon } from '#/components/icons'
import { SearchField } from '#/components/search-field'
import { Button } from '#/components/ui/button'
import {
  assignAdminUserBadge,
  fetchAdminBadges,
  fetchAdminUser,
  fetchAdminUserBadges,
  removeAdminUserBadge,
} from '#/features/api/admin-api'
import { useAuth } from '#/features/auth/auth-context'
import { queryKeys } from '#/lib/api/query-keys'

const usersSearchSchema = z.object({ u: z.string().optional() })

export const Route = createFileRoute('/_admin/users/')({
  validateSearch: usersSearchSchema,
  component: UsersPage,
})

function UsersPage() {
  const auth = useAuth()
  const token = auth.session?.token
  const navigate = useNavigate({ from: '/users' })
  const search = Route.useSearch()
  const queryClient = useQueryClient()

  const [query, setQuery] = useState('')
  const [selectedUser, setSelectedUser] = useState<User | null>(null)

  const badgesQuery = useQuery({
    queryKey: queryKeys.admin.badges,
    queryFn: () => fetchAdminBadges(token!),
    enabled: Boolean(token),
  })

  const userBadgesQuery = useQuery({
    queryKey: selectedUser
      ? queryKeys.admin.userBadges(selectedUser._id)
      : queryKeys.admin.userBadges(''),
    queryFn: () => fetchAdminUserBadges(token!, selectedUser!._id),
    enabled: Boolean(token && selectedUser),
  })

  const findUserMutation = useMutation({
    mutationFn: async (lookup: string) => {
      if (!token) throw new Error('Нет сессии')
      return fetchAdminUser(token, lookup)
    },
    onSuccess: (user) => {
      setSelectedUser(user)
      void navigate({ search: { u: user._id }, replace: true })
    },
    onError: (e) => {
      setSelectedUser(null)
      toast.error(e instanceof Error ? e.message : 'Не найден')
    },
  })

  useEffect(() => {
    if (!search.u || !token || selectedUser) return
    setQuery(search.u)
    findUserMutation.mutate(search.u)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.u, token])

  const assignMutation = useMutation({
    mutationFn: async (badge: Badge) => {
      if (!token || !selectedUser) throw new Error('Нет пользователя')
      return assignAdminUserBadge(token, selectedUser._id, badge._id)
    },
    onSuccess: (assigned) => {
      if (!selectedUser) return
      queryClient.setQueryData(queryKeys.admin.userBadges(selectedUser._id), assigned)
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    },
  })

  const removeMutation = useMutation({
    mutationFn: async (badge: Badge) => {
      if (!token || !selectedUser) throw new Error('Нет пользователя')
      return removeAdminUserBadge(token, selectedUser._id, badge._id)
    },
    onSuccess: (assigned) => {
      if (!selectedUser) return
      queryClient.setQueryData(queryKeys.admin.userBadges(selectedUser._id), assigned)
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    },
  })

  const assignedIds = useMemo(
    () => new Set((userBadgesQuery.data ?? []).map((b) => b._id)),
    [userBadgesQuery.data],
  )

  const all = badgesQuery.data ?? []
  const assigned = all.filter((b) => assignedIds.has(b._id))
  const available = all.filter((b) => !assignedIds.has(b._id))
  const busy = assignMutation.isPending || removeMutation.isPending

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const lookup = query.trim() || search.u
    if (!lookup) return
    findUserMutation.mutate(lookup)
  }

  return (
    <AdminPage title="Пользователи">
      <form onSubmit={submit} className="mb-5 flex flex-col gap-2 sm:flex-row">
        <SearchField
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="id, username или username#0001"
          className="flex-1"
        />
        <Button
          type="submit"
          size="sm"
          className="sm:shrink-0"
          disabled={findUserMutation.isPending || !(query.trim() || search.u)}
        >
          {findUserMutation.isPending ? (
            <Loader2Icon className="size-4 animate-spin" aria-hidden />
          ) : null}
          Найти
        </Button>
      </form>

      {!selectedUser ? (
        <AdminEmpty>Найдите пользователя, чтобы управлять бейджами</AdminEmpty>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-3 text-[13px]">
            <div className="min-w-0">
              <div className="font-medium">
                {selectedUser.display_name ?? selectedUser.username}
              </div>
              <div className="text-muted-foreground">@{selectedUser.username}</div>
              <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                {selectedUser._id}
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectedUser(null)
                setQuery('')
                void navigate({ search: { u: undefined }, replace: true })
              }}
            >
              Сбросить
            </Button>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <BadgeList
              title={`Выданные · ${assigned.length}`}
              badges={assigned}
              loading={userBadgesQuery.isLoading}
              icon={XIcon}
              label="Снять"
              variant="ghost"
              disabled={busy}
              onAction={(b) => removeMutation.mutate(b)}
            />
            <BadgeList
              title={`Доступные · ${available.length}`}
              badges={available}
              loading={badgesQuery.isLoading}
              icon={PlusIcon}
              label="Выдать"
              variant="outline"
              disabled={busy}
              onAction={(b) => assignMutation.mutate(b)}
            />
          </div>
        </div>
      )}
    </AdminPage>
  )
}

function BadgeList({
  title,
  badges,
  loading,
  icon: Icon,
  label,
  variant,
  disabled,
  onAction,
}: {
  title: string
  badges: Badge[]
  loading: boolean
  icon: typeof PlusIcon
  label: string
  variant: 'ghost' | 'outline'
  disabled: boolean
  onAction: (badge: Badge) => void
}) {
  return (
    <AdminSection>
      <AdminSectionHeader>{title}</AdminSectionHeader>
      {loading ? (
        <div className="flex h-20 items-center justify-center text-[13px] text-muted-foreground">
          <Loader2Icon className="mr-2 size-4 animate-spin" aria-hidden />
        </div>
      ) : badges.length === 0 ? (
        <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">
          Пусто
        </div>
      ) : (
        <ul>
          {badges.map((badge) => (
            <li
              key={badge._id}
              className="flex items-center gap-2 border-b border-border/50 px-3 py-2 last:border-0"
            >
              <BadgeIcon badge={badge} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">{badge.name}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {badge.slug}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant={variant}
                disabled={disabled}
                onClick={() => onAction(badge)}
                aria-label={label}
              >
                <Icon className="size-3.5" aria-hidden />
                <span className="hidden sm:inline">{label}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </AdminSection>
  )
}
