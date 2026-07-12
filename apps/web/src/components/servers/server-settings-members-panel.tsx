import { useMemo, useState } from 'react'
import type { Member, User } from '@syrnike13/api-types'

import { SearchIcon } from '#/components/icons'
import { Input } from '#/components/ui/input'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserInteractiveShell } from '#/components/user/user-interactive-shell'
import {
  listServerMembers,
  memberRoleEntries,
} from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { roleColourStyle } from '#/lib/server-permissions'

type ServerSettingsMembersPanelProps = {
  serverId: string
}

type MemberSort = 'name' | 'joined' | 'roles'

function memberDisplayName(user: User, member?: Member) {
  return member?.nickname?.trim() || user.display_name || user.username
}

function formatJoinedAt(value: string | undefined) {
  if (!value) return 'Неизвестно'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Неизвестно'
  return new Intl.DateTimeFormat('ru', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date)
}

export function ServerSettingsMembersPanel({
  serverId,
}: ServerSettingsMembersPanelProps) {
  const server = useSyncStore((s) => s.servers[serverId])
  const members = useSyncStore((s) => listServerMembers(s, serverId))
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<MemberSort>('name')

  const filteredMembers = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const list = normalized
      ? members.filter(({ member, user }) => {
          const name = memberDisplayName(user, member).toLowerCase()
          const globalName = (user.display_name ?? '').toLowerCase()
          const username = user.username.toLowerCase()
          const roles = memberRoleEntries(server, member)
            .map((role) => role.name.toLowerCase())
            .join(' ')

          return (
            name.includes(normalized) ||
            globalName.includes(normalized) ||
            username.includes(normalized) ||
            roles.includes(normalized)
          )
        })
      : members

    return [...list].sort((a, b) => {
      if (sort === 'joined') {
        return (
          Date.parse(b.member.joined_at) - Date.parse(a.member.joined_at)
        )
      }

      if (sort === 'roles') {
        return (
          memberRoleEntries(server, b.member).length -
          memberRoleEntries(server, a.member).length
        )
      }

      return memberDisplayName(a.user, a.member).localeCompare(
        memberDisplayName(b.user, b.member),
        'ru',
      )
    })
  }, [members, query, server, sort])

  if (!server) return null

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">Участники</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {members.length} участников. Действия доступны через ПКМ по строке.
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск участников…"
            className="h-9 bg-muted/40 pl-9"
          />
        </div>
        <select
          value={sort}
          className="h-9 rounded-md border border-input bg-muted/40 px-3 text-sm outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:border-border dark:bg-secondary dark:text-secondary-foreground"
          aria-label="Сортировка участников"
          onChange={(event) => setSort(event.target.value as MemberSort)}
        >
          <option value="name">Сортировать по имени</option>
          <option value="joined">Сортировать по дате входа</option>
          <option value="roles">Сортировать по ролям</option>
        </select>
      </div>

      <div className="overflow-hidden rounded-md border border-border">
        <div className="grid grid-cols-[minmax(12rem,1.4fr)_minmax(9rem,1fr)_8.5rem_3rem] gap-3 border-b border-border bg-muted/30 px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          <span>Имя</span>
          <span>Роли</span>
          <span>Дата вступления</span>
          <span className="text-right">Действия</span>
        </div>
        <div className="max-h-[32rem] overflow-y-auto">
          {filteredMembers.map(({ member, user }) => {
            const roles = memberRoleEntries(server, member)
            const displayName = memberDisplayName(user, member)

            return (
              <UserInteractiveShell
                key={user._id}
                user={user}
                serverId={serverId}
                serverName={server.name}
                roles={roles}
                align="start"
                side="right"
              >
                <button
                  type="button"
                  className="grid min-h-12 w-full grid-cols-[minmax(12rem,1.4fr)_minmax(9rem,1fr)_8.5rem_3rem] items-center gap-3 border-b border-border/70 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-muted/35 focus-visible:bg-muted/45 focus-visible:outline-none"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <UserAvatar user={user} className="size-8 shrink-0" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">
                        {displayName}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        @{user.username}
                      </span>
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-wrap gap-1">
                    {roles.length > 0 ? (
                      roles.slice(0, 3).map((role) => (
                        <span
                          key={role.id}
                          className="max-w-32 truncate rounded bg-muted px-1.5 py-0.5 text-xs font-medium"
                          style={roleColourStyle(role.colour)}
                        >
                          {role.name}
                        </span>
                      ))
                    ) : (
                      <span className="text-sm text-muted-foreground">-</span>
                    )}
                    {roles.length > 3 ? (
                      <span className="text-xs font-medium text-muted-foreground">
                        +{roles.length - 3}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {formatJoinedAt(member.joined_at)}
                  </span>
                  <span
                    className="text-right text-lg leading-none text-muted-foreground"
                    aria-hidden
                  >
                    ⋯
                  </span>
                </button>
              </UserInteractiveShell>
            )
          })}
          {filteredMembers.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              Участники не найдены
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
