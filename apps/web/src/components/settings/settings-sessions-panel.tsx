import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2Icon, MonitorIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'

import { SettingsBlock } from '#/components/settings/settings-panels'
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
    <div className="space-y-2">
      {current ? (
        <SettingsBlock title="Текущая сессия">
          <div className="flex items-start gap-3 py-3">
            <MonitorIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-base font-medium">
                {current.name || 'Это устройство'}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Создана {formatSessionDate(current._id)}
              </p>
            </div>
          </div>
        </SettingsBlock>
      ) : null}

      <SettingsBlock
        title={others.length > 0 ? `Другие сессии (${others.length})` : 'Другие сессии'}
      >
        {others.length > 0 ? (
          <>
            <div className="flex justify-end pb-2">
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
            <ul className="divide-y divide-border/40">
              {others.map((session) => (
                <li
                  key={session._id}
                  className="flex items-center gap-3 py-3"
                >
                  <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-medium">
                      {session.name || 'Сессия'}
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
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
          </>
        ) : (
          <p className="py-3 text-sm text-muted-foreground">
            Других активных сессий нет.
          </p>
        )}
      </SettingsBlock>
    </div>
  )
}
