import { useInfiniteQuery } from '@tanstack/react-query'
import type {
  ServerAuditLogEntry,
  ServerAuditLogTarget,
} from '@syrnike13/api-types'

import { Button } from '#/components/ui/button'
import { useAuth } from '#/features/auth/auth-context'
import { fetchServerAuditLog } from '#/features/api/servers-api'

type ServerSettingsAuditPanelProps = {
  serverId: string
}

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
          {entry.action.type}
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
  const auditQuery = useInfiniteQuery({
    queryKey: ['server-audit-log', serverId],
    enabled: Boolean(token),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchServerAuditLog(token!, serverId, {
        limit: 50,
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
