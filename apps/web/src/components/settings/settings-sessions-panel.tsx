import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2Icon, MonitorIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { useAuth } from '#/features/auth/auth-context'
import {
  deleteSession,
  fetchSessions,
  revokeOtherSessions,
} from '#/features/api/sessions-api'
import { loadSession } from '#/lib/session'

function formatSessionDate(sessionId: string) {
  try {
    const timestamp = Number.parseInt(sessionId.slice(0, 10), 16) * 1000
    return new Date(timestamp).toLocaleString('ru-RU')
  } catch {
    return '—'
  }
}

export function SettingsSessionsPanel() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const token = auth.session?.token
  const currentSessionId = loadSession()?._id

  const sessionsQuery = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: () => fetchSessions(token!),
    enabled: Boolean(token),
  })

  async function revokeSession(sessionId: string) {
    if (!token) return
    if (!window.confirm('Завершить эту сессию?')) return

    try {
      await deleteSession(token, sessionId)
      await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] })
      toast.success('Сессия завершена')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось завершить сессию',
      )
    }
  }

  async function revokeAllOthers() {
    if (!token) return
    if (!window.confirm('Завершить все сессии, кроме текущей?')) return

    try {
      await revokeOtherSessions(token)
      await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] })
      toast.success('Другие сессии завершены')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось завершить сессии',
      )
    }
  }

  if (sessionsQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        Загрузка сессий…
      </div>
    )
  }

  if (sessionsQuery.isError) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        Не удалось загрузить список сессий.
      </p>
    )
  }

  const sessions = sessionsQuery.data ?? []
  const others = sessions.filter((s) => s._id !== currentSessionId)
  const current =
    sessions.find((s) => s._id === currentSessionId) ?? sessions[0]

  return (
    <div className="space-y-4">
      {current ? (
        <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Текущая сессия
          </p>
          <div className="mt-2 flex items-start gap-3">
            <MonitorIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="font-medium">{current.name || 'Это устройство'}</p>
              <p className="text-xs text-muted-foreground">
                Создана {formatSessionDate(current._id)}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {others.length > 0 ? (
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Другие сессии ({others.length})
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => void revokeAllOthers()}
            >
              Завершить все
            </Button>
          </div>
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
            {others.map((session) => (
              <li
                key={session._id}
                className="flex items-center gap-3 px-3 py-2.5"
              >
                <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {session.name || 'Сессия'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatSessionDate(session._id)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-destructive"
                  title="Завершить"
                  onClick={() => void revokeSession(session._id)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Других активных сессий нет.
        </p>
      )}
    </div>
  )
}
