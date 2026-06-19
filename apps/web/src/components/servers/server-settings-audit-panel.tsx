import { useInfiniteQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type {
  ServerAuditLogAction,
  ServerAuditLogEntry,
  ServerAuditLogTarget,
} from '@syrnike13/api-types'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { useAuth } from '#/features/auth/auth-context'
import { fetchServerAuditLog } from '#/features/api/servers-api'

type ServerSettingsAuditPanelProps = {
  serverId: string
}

type AuditActionType = ServerAuditLogAction['type']
type AuditTargetType = ServerAuditLogTarget['type']

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
  'InviteUpdate',
  'InviteRevoke',
  'InviteDelete',
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

const AUDIT_TARGET_TYPES: AuditTargetType[] = [
  'Server',
  'Role',
  'Member',
  'User',
  'Invite',
  'Channel',
  'Category',
]

function targetLabel(target: ServerAuditLogTarget) {
  switch (target.type) {
    case 'Member':
      return target.user_id
    case 'Invite':
      return target.code
    default:
      return target.id
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

function AuditEntryRow({ entry }: { entry: ServerAuditLogEntry }) {
  const changeKeys = Object.keys(entry.changes)

  return (
    <li className="rounded-md border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-muted px-2 py-0.5 text-xs font-semibold text-foreground">
          {AUDIT_ACTION_LABELS[entry.action.type]}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatAuditTime(entry.created_at)}
        </span>
        {entry.status !== 'Succeeded' ? (
          <span className="rounded bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
            {entry.status}
          </span>
        ) : null}
      </div>

      <dl className="mt-2 grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Автор</dt>
        <dd className="min-w-0 truncate">{entry.actor_id}</dd>
        <dt className="text-muted-foreground">Объект</dt>
        <dd className="min-w-0 truncate">{targetLabel(entry.target)}</dd>
        {entry.reason ? (
          <>
            <dt className="text-muted-foreground">Причина</dt>
            <dd className="min-w-0 truncate">{entry.reason}</dd>
          </>
        ) : null}
        {changeKeys.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Поля</dt>
            <dd className="min-w-0 truncate">{changeKeys.join(', ')}</dd>
          </>
        ) : null}
      </dl>
    </li>
  )
}

export function ServerSettingsAuditPanel({
  serverId,
}: ServerSettingsAuditPanelProps) {
  const auth = useAuth()
  const token = auth.session?.token
  const [actorFilter, setActorFilter] = useState('')
  const [actionFilter, setActionFilter] = useState<AuditActionType | ''>('')
  const [targetTypeFilter, setTargetTypeFilter] = useState<AuditTargetType | ''>(
    '',
  )
  const [targetIdFilter, setTargetIdFilter] = useState('')

  const filters = useMemo(
    () => ({
      ...(actorFilter.trim() ? { actor: actorFilter.trim() } : {}),
      ...(actionFilter ? { action: actionFilter } : {}),
      ...(targetTypeFilter ? { target_type: targetTypeFilter } : {}),
      ...(targetIdFilter.trim() ? { target_id: targetIdFilter.trim() } : {}),
    }),
    [actionFilter, actorFilter, targetIdFilter, targetTypeFilter],
  )
  const hasFilters = Object.keys(filters).length > 0
  const auditQuery = useInfiniteQuery({
    queryKey: [
      'server-audit-log',
      serverId,
      filters.actor,
      filters.action,
      filters.target_type,
      filters.target_id,
    ],
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

      <section className="grid gap-3 border-b border-border/60 pb-4 md:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="audit-action-filter">Действие</Label>
          <select
            id="audit-action-filter"
            value={actionFilter}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) =>
              setActionFilter(event.target.value as AuditActionType | '')
            }
          >
            <option value="">Все</option>
            {AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {AUDIT_ACTION_LABELS[action]}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="audit-actor-filter">Автор</Label>
          <Input
            id="audit-actor-filter"
            value={actorFilter}
            placeholder="user id"
            onChange={(event) => setActorFilter(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="audit-target-type-filter">Тип объекта</Label>
          <select
            id="audit-target-type-filter"
            value={targetTypeFilter}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            onChange={(event) =>
              setTargetTypeFilter(event.target.value as AuditTargetType | '')
            }
          >
            <option value="">Все</option>
            {AUDIT_TARGET_TYPES.map((targetType) => (
              <option key={targetType} value={targetType}>
                {targetType}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="audit-target-id-filter">ID объекта</Label>
          <div className="flex gap-2">
            <Input
              id="audit-target-id-filter"
              value={targetIdFilter}
              placeholder="target id"
              onChange={(event) => setTargetIdFilter(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!hasFilters}
              onClick={() => {
                setActorFilter('')
                setActionFilter('')
                setTargetTypeFilter('')
                setTargetIdFilter('')
              }}
            >
              Сбросить
            </Button>
          </div>
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
              <AuditEntryRow key={entry._id} entry={entry} />
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
