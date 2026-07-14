import { useInfiniteQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
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
  ChevronUpIcon,
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
import { Button } from '#/components/ui/button'
import { FloatingMenu, FloatingMenuItem } from '#/components/ui/floating-menu'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
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

type MenuPosition = {
  x: number
  y: number
}

type ActionPresentation = {
  label: string
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

const AUDIT_ACTION_LABELS: Record<AuditActionType, string> = {
  ServerUpdate: 'Изменение сервера',
  RoleCreate: 'Создание роли',
  RoleUpdate: 'Изменение роли',
  RoleDelete: 'Удаление роли',
  RoleReorder: 'Изменение порядка ролей',
  ChannelCreate: 'Создание канала',
  ChannelUpdate: 'Изменение канала',
  ChannelDelete: 'Удаление канала',
  MemberUpdate: 'Изменение участника',
  MemberKick: 'Исключение участника',
  MemberBan: 'Бан участника',
  MemberUnban: 'Разбан участника',
  MemberTimeout: 'Тайм-аут участника',
  InviteCreate: 'Создание приглашения',
  InviteUpdate: 'Изменение приглашения',
  InviteRevoke: 'Отзыв приглашения',
  InviteDelete: 'Удаление приглашения',
  ChannelPermissionUpdate: 'Изменение прав канала',
  ServerPermissionUpdate: 'Изменение прав сервера',
}

const ACTION_PRESENTATION: Record<AuditActionType, ActionPresentation> = {
  ServerUpdate: {
    label: AUDIT_ACTION_LABELS.ServerUpdate,
    icon: ServerIcon,
    tone: 'yellow',
  },
  RoleCreate: {
    label: AUDIT_ACTION_LABELS.RoleCreate,
    icon: ShieldIcon,
    tone: 'green',
  },
  RoleUpdate: {
    label: AUDIT_ACTION_LABELS.RoleUpdate,
    icon: ShieldIcon,
    tone: 'yellow',
  },
  RoleDelete: {
    label: AUDIT_ACTION_LABELS.RoleDelete,
    icon: ShieldIcon,
    tone: 'red',
  },
  RoleReorder: {
    label: AUDIT_ACTION_LABELS.RoleReorder,
    icon: ShieldIcon,
    tone: 'blue',
  },
  ChannelCreate: {
    label: AUDIT_ACTION_LABELS.ChannelCreate,
    icon: HashIcon,
    tone: 'green',
  },
  ChannelUpdate: {
    label: AUDIT_ACTION_LABELS.ChannelUpdate,
    icon: HashIcon,
    tone: 'yellow',
  },
  ChannelDelete: {
    label: AUDIT_ACTION_LABELS.ChannelDelete,
    icon: HashIcon,
    tone: 'red',
  },
  MemberUpdate: {
    label: AUDIT_ACTION_LABELS.MemberUpdate,
    icon: UserIcon,
    tone: 'yellow',
  },
  MemberKick: {
    label: AUDIT_ACTION_LABELS.MemberKick,
    icon: UserMinusIcon,
    tone: 'red',
  },
  MemberBan: {
    label: AUDIT_ACTION_LABELS.MemberBan,
    icon: BanIcon,
    tone: 'red',
  },
  MemberUnban: {
    label: AUDIT_ACTION_LABELS.MemberUnban,
    icon: CircleCheckIcon,
    tone: 'green',
  },
  MemberTimeout: {
    label: AUDIT_ACTION_LABELS.MemberTimeout,
    icon: InfoIcon,
    tone: 'yellow',
  },
  InviteCreate: {
    label: AUDIT_ACTION_LABELS.InviteCreate,
    icon: PlusCircleIcon,
    tone: 'green',
  },
  InviteUpdate: {
    label: AUDIT_ACTION_LABELS.InviteUpdate,
    icon: PencilIcon,
    tone: 'yellow',
  },
  InviteRevoke: {
    label: AUDIT_ACTION_LABELS.InviteRevoke,
    icon: Trash2Icon,
    tone: 'red',
  },
  InviteDelete: {
    label: AUDIT_ACTION_LABELS.InviteDelete,
    icon: Trash2Icon,
    tone: 'red',
  },
  ChannelPermissionUpdate: {
    label: AUDIT_ACTION_LABELS.ChannelPermissionUpdate,
    icon: SettingsIcon,
    tone: 'yellow',
  },
  ServerPermissionUpdate: {
    label: AUDIT_ACTION_LABELS.ServerPermissionUpdate,
    icon: SettingsIcon,
    tone: 'yellow',
  },
}

const AUDIT_STATUS_LABELS: Record<ServerAuditLogEntry['status'], string> = {
  Pending: 'В процессе',
  Succeeded: 'Выполнено',
  Failed: 'Ошибка',
}

const CHANGE_FIELD_LABELS: Record<string, string> = {
  analytics: 'Аналитика',
  avatar: 'Аватар',
  can_publish: 'Микрофон на сервере',
  can_receive: 'Звук на сервере',
  categories: 'Категории',
  channel: 'Канал',
  channels: 'Каналы',
  colour: 'Цвет',
  color: 'Цвет',
  default_permissions: 'Права по умолчанию',
  delete_message_seconds: 'Удаление сообщений',
  description: 'Описание',
  discoverable: 'Публичный сервер',
  expires_at: 'Истекает',
  flags: 'Флаги',
  hoist: 'Показывать отдельно',
  icon: 'Иконка',
  max_uses: 'Лимит использований',
  mentionable: 'Можно упоминать',
  name: 'Название',
  nickname: 'Никнейм',
  nsfw: 'NSFW',
  owner: 'Владелец',
  permissions: 'Права',
  ranks: 'Порядок ролей',
  reason: 'Причина',
  role: 'Роль',
  roles: 'Роли',
  slowmode: 'Медленный режим',
  system_messages: 'Системные сообщения',
  temporary: 'Временное членство',
  timeout: 'Тайм-аут',
  voice: 'Голосовые настройки',
  voice_channel: 'Голосовой канал',
}

function userLabel(user: User | undefined, fallback: string) {
  return user?.display_name || user?.username || fallback
}

function roleNameFromValue(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
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
  changes?: AuditChanges,
) {
  const targetText = targetName(target, context, changes)

  switch (action) {
    case 'InviteCreate':
      return `${actorLabel} создал ссылку-приглашение ${targetText}`
    case 'InviteRevoke':
    case 'InviteDelete':
      return `${actorLabel} удалил ссылку-приглашение ${targetText}`
    case 'RoleCreate':
      return `${actorLabel} создал роль ${targetText}`
    case 'RoleUpdate':
      return `${actorLabel} обновляет роль ${targetText}`
    case 'RoleDelete':
      return `${actorLabel} удалил роль ${targetText}`
    case 'RoleReorder':
      return `${actorLabel} изменил порядок ролей`
    case 'ChannelCreate':
      return `${actorLabel} создал канал ${targetText}`
    case 'ChannelUpdate':
      return `${actorLabel} обновляет канал ${targetText}`
    case 'ChannelDelete':
      return `${actorLabel} удалил канал ${targetText}`
    case 'MemberUpdate':
      return `${actorLabel} изменил участника ${targetText}`
    case 'MemberKick':
      return `${actorLabel} исключил участника ${targetText}`
    case 'MemberBan':
      return `${actorLabel} забанил участника ${targetText}`
    case 'MemberUnban':
      return `${actorLabel} снял бан с участника ${targetText}`
    case 'MemberTimeout':
      return `${actorLabel} изменил тайм-аут участника ${targetText}`
    case 'ServerPermissionUpdate':
      return `${actorLabel} изменил права сервера`
    case 'ChannelPermissionUpdate':
      return `${actorLabel} изменил права канала ${targetText}`
    case 'ServerUpdate':
    default:
      return `${actorLabel} обновляет сервер`
  }
}

function formatAuditTime(timestamp: number) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function formatRoleList(value: unknown, server?: Server) {
  if (!Array.isArray(value)) return undefined

  return value
    .map((item) => {
      if (typeof item === 'string') return roleLabel(item, server)
      if (
        Array.isArray(item) &&
        typeof item[0] === 'string' &&
        typeof item[1] === 'number'
      ) {
        return `${roleLabel(item[0], server)}: позиция ${item[1] + 1}`
      }
      return formatAuditChangeValue(item, undefined, server)
    })
    .join(', ')
}

function formatAuditChangeValue(
  value: unknown,
  key?: string,
  server?: Server,
  channels: Record<string, Channel> = {},
): string {
  if (value === null || value === undefined || value === '') {
    return '—'
  }

  if ((key === 'roles' || key === 'ranks') && Array.isArray(value)) {
    return formatRoleList(value, server) ?? '—'
  }

  if (
    (key === 'channel' || key === 'voice_channel') &&
    typeof value === 'string'
  ) {
    return channelLabel(value, channels)
  }

  if (typeof value === 'boolean') {
    return value ? 'Да' : 'Нет'
  }

  if (typeof value === 'number') {
    if ((key === 'expires_at' || key === 'timeout') && value > 0) {
      return formatAuditTime(value)
    }
    return String(value)
  }

  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => formatAuditChangeValue(item, key, server, channels))
      .join(', ')
  }

  if (typeof value === 'object' && value) {
    const record = value as Record<string, unknown>
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

function changeFieldLabel(key: string) {
  return CHANGE_FIELD_LABELS[key] ?? key.replaceAll('_', ' ')
}

function menuPositionFromButton(button: HTMLButtonElement): MenuPosition {
  const rect = button.getBoundingClientRect()
  return {
    x: Math.max(8, rect.left),
    y: rect.bottom + 4,
  }
}

function iconToneClass(tone: ActionPresentation['tone']) {
  switch (tone) {
    case 'green':
      return 'text-emerald-400'
    case 'red':
      return 'text-red-400'
    case 'yellow':
      return 'text-amber-400'
    case 'blue':
      return 'text-sky-400'
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
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const selected = value ? ACTION_PRESENTATION[value] : null
  const SelectedIcon = selected?.icon

  return (
    <div className="space-y-1.5">
      <Label>Фильтр по действиям</Label>
      <button
        type="button"
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-haspopup="menu"
        aria-expanded={menuPosition ? true : undefined}
        onClick={(event) => {
          const nextPosition = menuPositionFromButton(event.currentTarget)
          setMenuPosition((current) => current ? null : nextPosition)
        }}
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
            {selected?.label ?? 'Все действия'}
          </span>
        </span>
        {menuPosition ? (
          <ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      <FloatingMenu
        open={Boolean(menuPosition)}
        x={menuPosition?.x ?? 0}
        y={menuPosition?.y ?? 0}
        onClose={() => setMenuPosition(null)}
        className="max-h-80 w-64 overflow-y-auto"
      >
        <FloatingMenuItem
          onClick={() => {
            onChange('')
            setMenuPosition(null)
          }}
        >
          <SettingsIcon className="size-4 text-muted-foreground" />
          Все действия
        </FloatingMenuItem>
        {AUDIT_ACTIONS.map((action) => {
          const presentation = ACTION_PRESENTATION[action]

          return (
            <FloatingMenuItem
              key={action}
              onClick={() => {
                onChange(action)
                setMenuPosition(null)
              }}
            >
              <AuditActionIcon action={action} />
              <span className="truncate">{presentation.label}</span>
            </FloatingMenuItem>
          )
        })}
      </FloatingMenu>
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
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
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
      <Label>Фильтр по пользователям</Label>
      <button
        type="button"
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        aria-haspopup="menu"
        aria-expanded={menuPosition ? true : undefined}
        onClick={(event) => {
          const nextPosition = menuPositionFromButton(event.currentTarget)
          setMenuPosition((current) => current ? null : nextPosition)
        }}
      >
        <span className="flex min-w-0 items-center gap-2">
          {selected ? (
            <UserAvatar user={selected} className="size-5 shrink-0" />
          ) : (
            <UsersIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">
            {selected ? userLabel(selected, selected._id) : 'Все пользователи'}
          </span>
        </span>
        {menuPosition ? (
          <ChevronUpIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      <FloatingMenu
        open={Boolean(menuPosition)}
        x={menuPosition?.x ?? 0}
        y={menuPosition?.y ?? 0}
        onClose={() => setMenuPosition(null)}
        className="max-h-80 w-[260px] overflow-y-auto"
      >
        <div className="sticky top-0 z-10 bg-popover p-1">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              placeholder="Найти пользователя"
              className="h-8 pl-8"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <FloatingMenuItem
          onClick={() => {
            onChange('')
            setQuery('')
            setMenuPosition(null)
          }}
        >
          <UsersIcon className="size-4 text-muted-foreground" />
          Все пользователи
        </FloatingMenuItem>
        {visibleUsers.map((user) => (
          <FloatingMenuItem
            key={user._id}
            onClick={() => {
              onChange(user._id)
              setQuery('')
              setMenuPosition(null)
            }}
          >
            <UserAvatar user={user} className="size-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {userLabel(user, user._id)}
            </span>
          </FloatingMenuItem>
        ))}
        {visibleUsers.length === 0 ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            Пользователи не найдены
          </p>
        ) : null}
      </FloatingMenu>
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
            {formatAuditTime(entry.created_at)}
          </span>
        </span>
        {entry.status !== 'Succeeded' ? (
          <span className="rounded bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
            {AUDIT_STATUS_LABELS[entry.status]}
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
        <dl className="grid gap-x-3 gap-y-1 border-t border-border/70 px-14 py-3 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
          <dt className="text-muted-foreground">Действие</dt>
          <dd>{AUDIT_ACTION_LABELS[entry.action.type]}</dd>
          {entry.reason ? (
            <>
              <dt className="text-muted-foreground">Причина</dt>
              <dd className="min-w-0 break-words">{entry.reason}</dd>
            </>
          ) : null}
          {changeKeys.length > 0 ? (
            <>
              <dt className="text-muted-foreground">Изменения</dt>
              <dd className="min-w-0 space-y-1">
                {changeKeys.map((key, index) => {
                  const change = entry.changes[key]

                  return (
                    <p
                      key={key}
                      className="whitespace-normal break-words leading-relaxed"
                    >
                      <span className="mr-2 font-mono text-xs text-emerald-400">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      {changeFieldLabel(key)}:{' '}
                      {formatAuditChangeValue(
                        change?.before,
                        key,
                        server,
                        channels,
                      )}{' '}
                      →{' '}
                      {formatAuditChangeValue(
                        change?.after,
                        key,
                        server,
                        channels,
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
    queryFn: ({ pageParam }) =>
      fetchServerAuditLog(token!, serverId, {
        limit: 50,
        ...filters,
        ...(pageParam ? { before: pageParam } : {}),
      }),
    getNextPageParam: (lastPage) => lastPage.next_before ?? undefined,
  })

  const entries = auditQuery.data?.pages.flatMap((page) => page.entries) ?? []

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">Журнал аудита</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Последние административные действия на сервере.
        </p>
      </div>

      <section className="grid gap-3 border-b border-border/60 pb-4 md:grid-cols-[minmax(13rem,16rem)_minmax(13rem,16rem)_auto]">
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
            Сбросить
          </Button>
        </div>
      </section>

      {auditQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Загрузка...</p>
      ) : auditQuery.error ? (
        <p className="text-sm text-destructive">
          Не удалось загрузить журнал аудита.
        </p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Записей пока нет</p>
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
              Загрузить ещё
            </Button>
          ) : null}
        </>
      )}
    </div>
  )
}
