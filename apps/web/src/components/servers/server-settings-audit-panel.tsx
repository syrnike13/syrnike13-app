import { useInfiniteQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Option, Schema } from 'effect'
import {
  useLocale,
  useTranslations,
  type AppLocale,
  type Translator,
} from '@syrnike13/ui/i18n'
import type {
  Channel,
  Server,
  ServerAuditLogAction,
  ServerAuditLogEntry,
  ServerAuditLogTarget,
  User,
} from '@syrnike13/api-types'

import type { AppIcon } from '#/components/icons'
import {
  BanIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  HashIcon,
  InfoIcon,
  PencilIcon,
  PlusCircleIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  ShieldIcon,
  Trash2Icon,
  UserIcon,
  UserMinusIcon,
  UsersIcon,
} from '#/components/icons'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import { UserAvatar } from '#/components/user/user-avatar'
import { useAuth } from '#/features/auth/auth-context'
import { fetchServerAuditLog } from '#/features/api/servers-api'
import { useSyncStore } from '#/features/sync/sync-store'
import { cn } from '#/lib/utils'

type ServerSettingsAuditPanelProps = {
  serverId: string
}

type AuditActionType = ServerAuditLogAction['type']

type AuditLabelContext = {
  server?: Server
  channels: Record<string, Channel>
  users: Record<string, User>
  currentUserId?: string
}

type AuditChanges = ServerAuditLogEntry['changes']

type ActionPresentation = {
  icon: AppIcon
  tone?: 'green' | 'red' | 'yellow' | 'blue'
}

const AUDIT_ACTIONS: AuditActionType[] = [
  'ServerUpdate',
  'RoleCreate',
  'RoleUpdate',
  'RoleDelete',
  'RoleReorder',
  'ChannelCreate',
  'ChannelUpdate',
  'ChannelDelete',
  'MemberUpdate',
  'MemberKick',
  'MemberBan',
  'MemberUnban',
  'MemberTimeout',
  'InviteCreate',
  'InviteRevoke',
  'ChannelPermissionUpdate',
  'ServerPermissionUpdate',
]

const ACTION_PRESENTATION: Record<AuditActionType, ActionPresentation> = {
  ServerUpdate: {
    icon: ServerIcon,
    tone: 'yellow',
  },
  RoleCreate: {
    icon: ShieldIcon,
    tone: 'green',
  },
  RoleUpdate: {
    icon: ShieldIcon,
    tone: 'yellow',
  },
  RoleDelete: {
    icon: ShieldIcon,
    tone: 'red',
  },
  RoleReorder: {
    icon: ShieldIcon,
    tone: 'blue',
  },
  ChannelCreate: {
    icon: HashIcon,
    tone: 'green',
  },
  ChannelUpdate: {
    icon: HashIcon,
    tone: 'yellow',
  },
  ChannelDelete: {
    icon: HashIcon,
    tone: 'red',
  },
  MemberUpdate: {
    icon: UserIcon,
    tone: 'yellow',
  },
  MemberKick: {
    icon: UserMinusIcon,
    tone: 'red',
  },
  MemberBan: {
    icon: BanIcon,
    tone: 'red',
  },
  MemberUnban: {
    icon: CircleCheckIcon,
    tone: 'green',
  },
  MemberTimeout: {
    icon: InfoIcon,
    tone: 'yellow',
  },
  InviteCreate: {
    icon: PlusCircleIcon,
    tone: 'green',
  },
  InviteUpdate: {
    icon: PencilIcon,
    tone: 'yellow',
  },
  InviteRevoke: {
    icon: Trash2Icon,
    tone: 'red',
  },
  InviteDelete: {
    icon: Trash2Icon,
    tone: 'red',
  },
  ChannelPermissionUpdate: {
    icon: SettingsIcon,
    tone: 'yellow',
  },
  ServerPermissionUpdate: {
    icon: SettingsIcon,
    tone: 'yellow',
  },
}

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown)

function recordFromUnknown(value: unknown) {
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(UnknownRecordSchema)(value),
  )
}

function userLabel(user: User | undefined, fallback: string) {
  return user?.display_name || user?.username || fallback
}

function roleNameFromValue(value: unknown) {
  const record = recordFromUnknown(value)
  if (!record) return undefined
  return typeof record.name === 'string' && record.name.trim()
    ? record.name
    : undefined
}

function roleNameFromChanges(changes: AuditChanges | undefined) {
  return (
    roleNameFromValue(changes?.role?.before) ??
    roleNameFromValue(changes?.role?.after) ??
    (typeof changes?.name?.after === 'string' ? changes.name.after : undefined) ??
    (typeof changes?.name?.before === 'string' ? changes.name.before : undefined)
  )
}

function roleLabel(roleId: string, server?: Server, changes?: AuditChanges) {
  const name = server?.roles?.[roleId]?.name
  if (name) return `«${name}»`

  const changedName = roleNameFromChanges(changes)
  return changedName ? `«${changedName}»` : roleId
}

function channelLabel(channelId: string, channels: Record<string, Channel>) {
  const channel = channels[channelId]
  if (channel && 'name' in channel && typeof channel.name === 'string') {
    return `#${channel.name}`
  }
  return channelId
}

function targetName(
  target: ServerAuditLogTarget,
  context: AuditLabelContext,
  changes?: AuditChanges,
) {
  switch (target.type) {
    case 'Server':
      return context.server?.name ?? target.id
    case 'Role':
      return roleLabel(target.id, context.server, changes)
    case 'Member':
      return userLabel(context.users[target.user_id], target.user_id)
    case 'User':
      return userLabel(context.users[target.id], target.id)
    case 'Invite':
      return target.code
    case 'Channel':
      return channelLabel(target.id, context.channels)
    case 'Category':
      return target.id
  }
}

function humanAuditSentence(
  actorLabel: string,
  action: AuditActionType,
  target: ServerAuditLogTarget,
  context: AuditLabelContext,
  t: Translator,
  changes?: AuditChanges,
) {
  const targetText = targetName(target, context, changes)
  return t(`sentences.${action}`, { actor: actorLabel, target: targetText })
}

function formatAuditTime(timestamp: number, locale: AppLocale) {
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function formatRoleList(
  value: unknown,
  t: Translator,
  server?: Server,
  locale: AppLocale = 'ru',
) {
  if (!Array.isArray(value)) return undefined

  return value
    .map((item) => {
      if (typeof item === 'string') return roleLabel(item, server)
      if (
        Array.isArray(item) &&
        typeof item[0] === 'string' &&
        typeof item[1] === 'number'
      ) {
        return t('rolePosition', {
          role: roleLabel(item[0], server),
          position: item[1] + 1,
        })
      }
      return formatAuditChangeValue(item, undefined, server, {}, t, locale)
    })
    .join(', ')
}

function formatAuditChangeValue(
  value: unknown,
  key: string | undefined,
  server: Server | undefined,
  channels: Record<string, Channel>,
  t: Translator,
  locale: AppLocale = 'ru',
): string {
  if (value === null || value === undefined || value === '') {
    return '—'
  }

  if ((key === 'roles' || key === 'ranks') && Array.isArray(value)) {
    return formatRoleList(value, t, server, locale) ?? '—'
  }

  if (
    (key === 'channel' || key === 'voice_channel') &&
    typeof value === 'string'
  ) {
    return channelLabel(value, channels)
  }

  if (typeof value === 'boolean') {
    return value ? t('yes') : t('no')
  }

  if (typeof value === 'number') {
    if ((key === 'expires_at' || key === 'timeout') && value > 0) {
      return formatAuditTime(value, locale)
    }
    return String(value)
  }

  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value
      .map((item) =>
        formatAuditChangeValue(item, key, server, channels, t, locale),
      )
      .join(', ')
  }

  const record = recordFromUnknown(value)
  if (record) {
    if (typeof record.name === 'string') return record.name
    if (typeof record.id === 'string') return record.id
    if (typeof record._id === 'string') return record._id
  }

  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function changeFieldLabel(key: string, t: Translator) {
  const path = `fields.${key}`
  return t.has(path) ? t(path) : key.replaceAll('_', ' ')
}

function iconToneClass(tone: ActionPresentation['tone']) {
  switch (tone) {
    case 'green':
      return 'text-success'
    case 'red':
      return 'text-destructive'
    case 'yellow':
      return 'text-warning'
    case 'blue':
      return 'text-chart-4'
    default:
      return 'text-muted-foreground'
  }
}

function AuditActionIcon({
  action,
  className,
}: {
  action: AuditActionType
  className?: string
}) {
  const presentation = ACTION_PRESENTATION[action]
  const Icon = presentation.icon

  return <Icon className={cn('size-4', iconToneClass(presentation.tone), className)} />
}

function AuditActionFilter({
  value,
  onChange,
}: {
  value: AuditActionType | ''
  onChange: (value: AuditActionType | '') => void
}) {
  const t = useTranslations('audit')
  const selected = value ? ACTION_PRESENTATION[value] : null
  const SelectedIcon = selected?.icon

  return (
    <div className="space-y-1.5">
      <Label>{t('filters.actions')}</Label>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          }
        >
          <span className="flex min-w-0 items-center gap-2">
            {SelectedIcon ? (
              <SelectedIcon
                className={cn('size-4 shrink-0', iconToneClass(selected.tone))}
              />
            ) : (
              <SettingsIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">
              {value ? t(`actions.${value}`) : t('filters.allActions')}
            </span>
          </span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-80 w-64 overflow-y-auto">
          <DropdownMenuItem
            onClick={() => {
              onChange('')
            }}
          >
            <SettingsIcon className="size-4 text-muted-foreground" />
            {t('filters.allActions')}
          </DropdownMenuItem>
          {AUDIT_ACTIONS.map((action) => {
            return (
              <DropdownMenuItem
                key={action}
                onClick={() => {
                  onChange(action)
                }}
              >
                <AuditActionIcon action={action} />
                <span className="truncate">{t(`actions.${action}`)}</span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function AuditUserFilter({
  users,
  value,
  onChange,
}: {
  users: User[]
  value: string
  onChange: (userId: string) => void
}) {
  const t = useTranslations('audit')
  const [query, setQuery] = useState('')
  const selected = value ? users.find((user) => user._id === value) : undefined
  const normalizedQuery = query.trim().toLocaleLowerCase('ru-RU')
  const visibleUsers = users.filter((user) => {
    if (!normalizedQuery) return true
    return `${user.display_name ?? ''} ${user.username ?? ''} ${user._id}`
      .toLocaleLowerCase('ru-RU')
      .includes(normalizedQuery)
  })

  return (
    <div className="space-y-1.5">
      <Label>{t('filters.users')}</Label>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          }
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected ? (
              <UserAvatar user={selected} className="size-5 shrink-0" />
            ) : (
              <UsersIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">
              {selected
                ? userLabel(selected, selected._id)
                : t('filters.allUsers')}
            </span>
          </span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="max-h-80 w-65 overflow-y-auto">
          <div className="sticky top-0 z-10 bg-popover p-1">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                placeholder={t('filters.searchUser')}
                className="h-8 pl-8"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          <DropdownMenuItem
            onClick={() => {
              onChange('')
              setQuery('')
            }}
          >
            <UsersIcon className="size-4 text-muted-foreground" />
            {t('filters.allUsers')}
          </DropdownMenuItem>
          {visibleUsers.map((user) => (
            <DropdownMenuItem
              key={user._id}
              onClick={() => {
                onChange(user._id)
                setQuery('')
              }}
            >
              <UserAvatar user={user} className="size-5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {userLabel(user, user._id)}
              </span>
            </DropdownMenuItem>
          ))}
          {visibleUsers.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">
              {t('filters.noUsers')}
            </p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function AuditEntryRow({
  entry,
  currentUserId,
}: {
  entry: ServerAuditLogEntry
  currentUserId?: string
}) {
  const t = useTranslations('audit')
  const { locale } = useLocale()
  const [open, setOpen] = useState(false)
  const actor = useSyncStore((s) => s.users[entry.actor_id])
  const server = useSyncStore((s) => s.servers[entry.server_id])
  const channels = useSyncStore((s) => s.channels)
  const users = useSyncStore((s) => s.users)
  const changeKeys = Object.keys(entry.changes)
  const context = { server, channels, users, currentUserId }
  const actorName = userLabel(actor, entry.actor_id)
  const sentence = humanAuditSentence(
    actorName,
    entry.action.type,
    entry.target,
    context,
    t,
    entry.changes,
  )

  return (
    <li className="rounded-md border border-border bg-card/30">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/35"
        onClick={() => setOpen((current) => !current)}
      >
        <AuditActionIcon action={entry.action.type} className="shrink-0" />
        {actor ? (
          <UserAvatar user={actor} className="size-9 shrink-0" />
        ) : (
          <span className="size-9 shrink-0 rounded-full bg-muted" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">
            {sentence}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {formatAuditTime(entry.created_at, locale)}
          </span>
        </span>
        {entry.status !== 'Succeeded' ? (
          <span className="rounded bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
            {t(`status.${entry.status}`)}
          </span>
        ) : null}
        <ChevronDownIcon
          className={cn(
            'size-5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open ? (
        <dl className="grid gap-x-3 gap-y-1 border-t border-border px-14 py-3 text-sm audit-label-grid">
          <dt className="text-muted-foreground">{t('detail.action')}</dt>
          <dd>{t(`actions.${entry.action.type}`)}</dd>
          {entry.reason ? (
            <>
              <dt className="text-muted-foreground">{t('detail.reason')}</dt>
              <dd className="min-w-0 break-words">{entry.reason}</dd>
            </>
          ) : null}
          {changeKeys.length > 0 ? (
            <>
              <dt className="text-muted-foreground">{t('detail.changes')}</dt>
              <dd className="min-w-0 space-y-1">
                {changeKeys.map((key, index) => {
                  const change = entry.changes[key]

                  return (
                    <p
                      key={key}
                      className="whitespace-normal break-words leading-relaxed"
                    >
                      <span className="mr-2 font-mono text-xs text-success">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      {changeFieldLabel(key, t)}:{' '}
                      {formatAuditChangeValue(
                        change?.before,
                        key,
                        server,
                        channels,
                        t,
                        locale,
                      )}{' '}
                      →{' '}
                      {formatAuditChangeValue(
                        change?.after,
                        key,
                        server,
                        channels,
                        t,
                        locale,
                      )}
                    </p>
                  )
                })}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </li>
  )
}

export function ServerSettingsAuditPanel({
  serverId,
}: ServerSettingsAuditPanelProps) {
  const t = useTranslations('audit')
  const auth = useAuth()
  const token = auth.session?.token
  const usersById = useSyncStore((s) => s.users)
  const [actorFilter, setActorFilter] = useState('')
  const [actionFilter, setActionFilter] = useState<AuditActionType | ''>('')

  const users = useMemo(
    () =>
      Object.values(usersById).sort((a, b) =>
        userLabel(a, a._id).localeCompare(userLabel(b, b._id), 'ru-RU'),
      ),
    [usersById],
  )

  const filters = useMemo(
    () => ({
      ...(actorFilter.trim() ? { actor: actorFilter.trim() } : {}),
      ...(actionFilter ? { action: actionFilter } : {}),
    }),
    [actionFilter, actorFilter],
  )
  const hasFilters = Object.keys(filters).length > 0
  const auditQuery = useInfiniteQuery({
    queryKey: ['server-audit-log', serverId, filters.actor, filters.action],
    enabled: Boolean(token),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchServerAuditLog(
        token!,
        serverId,
        {
          limit: 50,
          ...filters,
          ...(pageParam ? { before: pageParam } : {}),
        },
        signal,
      ),
    getNextPageParam: (lastPage) => lastPage.next_before ?? undefined,
  })

  const entries = auditQuery.data?.pages.flatMap((page) => page.entries) ?? []

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">{t('title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('description')}
        </p>
      </div>

      <section className="grid gap-3 border-b border-border pb-4 settings-audit-grid">
        <AuditUserFilter
          users={users}
          value={actorFilter}
          onChange={setActorFilter}
        />
        <AuditActionFilter value={actionFilter} onChange={setActionFilter} />
        <div className="flex items-end">
          <Button
            type="button"
            variant="outline"
            disabled={!hasFilters}
            onClick={() => {
              setActorFilter('')
              setActionFilter('')
            }}
          >
            {t('reset')}
          </Button>
        </div>
      </section>

      {auditQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : auditQuery.error ? (
        <p className="text-sm text-destructive">{t('loadError')}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          <ul className="space-y-2">
            {entries.map((entry) => (
              <AuditEntryRow
                key={entry._id}
                entry={entry}
                currentUserId={auth.user?._id}
              />
            ))}
          </ul>
          {auditQuery.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              disabled={auditQuery.isFetchingNextPage}
              onClick={() => void auditQuery.fetchNextPage()}
            >
              {t('loadMore')}
            </Button>
          ) : null}
        </>
      )}
    </div>
  )
}
