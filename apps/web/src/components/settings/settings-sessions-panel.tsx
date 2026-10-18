import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { MonitorIcon, Trash2Icon } from '#/components/icons'
import { Effect } from 'effect'
import { toast } from 'sonner'
import {
  useLocale,
  useTranslations,
  type AppLocale,
} from '@syrnike13/ui/i18n'

import { SettingsBlock } from '#/components/settings/settings-panels'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@syrnike13/ui/primitives/alert-dialog'
import { Button } from '@syrnike13/ui/primitives/button'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { useAuth } from '#/features/auth/auth-context'
import {
  deleteSessionEffect,
  fetchSessions,
  revokeOtherSessionsEffect,
} from '#/features/api/sessions-api'
import { apiErrorMessage } from '#/lib/api/error-message'
import { loadSession } from '#/lib/session'

function formatSessionDate(sessionId: string, locale: AppLocale) {
  try {
    const timestamp = Number.parseInt(sessionId.slice(0, 10), 16) * 1000
    return new Date(timestamp).toLocaleString(locale)
  } catch {
    return '—'
  }
}

export function SettingsSessionsPanel() {
  const t = useTranslations('settings.sessions')
  const ts = useTranslations('settings.status')
  const { locale } = useLocale()
  const auth = useAuth()
  const queryClient = useQueryClient()
  const token = auth.session?.token
  const currentSessionId = loadSession()?._id
  const [pendingRevocation, setPendingRevocation] = useState<
    { type: 'revoke'; sessionId: string } | { type: 'revoke-others' } | null
  >(null)

  const sessionsQuery = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: ({ signal }) => fetchSessions(token!, signal),
    enabled: Boolean(token),
  })

  function revokeSession(sessionId: string) {
    if (!token) return

    Effect.runFork(
      deleteSessionEffect(token, sessionId).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () =>
              queryClient.invalidateQueries({
                queryKey: ['auth', 'sessions'],
              }),
            catch: (cause) => cause,
          }),
        ),
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              toast.error(apiErrorMessage(error, t('revokeError')))
            }),
          onSuccess: () =>
            Effect.sync(() => {
              toast.success(t('revokeSuccess'))
            }),
        }),
      ),
    )
  }

  function revokeAllOthers() {
    if (!token) return

    Effect.runFork(
      revokeOtherSessionsEffect(token).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () =>
              queryClient.invalidateQueries({
                queryKey: ['auth', 'sessions'],
              }),
            catch: (cause) => cause,
          }),
        ),
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              toast.error(apiErrorMessage(error, t('revokeOthersError')))
            }),
          onSuccess: () =>
            Effect.sync(() => {
              toast.success(t('revokeOthersSuccess'))
            }),
        }),
      ),
    )
  }

  if (sessionsQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        {t('loading')}
      </div>
    )
  }

  if (sessionsQuery.isError) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        {t('loadError')}
      </p>
    )
  }

  const sessions = sessionsQuery.data ?? []
  const others = sessions.filter((s) => s._id !== currentSessionId)
  const current =
    sessions.find((s) => s._id === currentSessionId) ?? sessions[0]

  return (
    <>
    <div className="space-y-2">
      {current ? (
        <SettingsBlock title={t('currentTitle')}>
          <div className="flex items-start gap-3 py-3">
            <MonitorIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-base font-medium">
                {current.name || t('thisDevice')}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('created', {
                  date: formatSessionDate(current._id, locale),
                })}
              </p>
            </div>
          </div>
        </SettingsBlock>
      ) : null}

      <SettingsBlock
        title={
          others.length > 0
            ? t('othersWithCount', { count: others.length })
            : t('others')
        }
      >
        {others.length > 0 ? (
          <>
            <div className="flex justify-end pb-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() =>
                  setPendingRevocation({ type: 'revoke-others' })
                }
              >
                {t('revokeAll')}
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
                      {session.name || t('session')}
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {formatSessionDate(session._id, locale)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-destructive"
                    title={t('revoke')}
                    onClick={() =>
                      setPendingRevocation({
                        type: 'revoke',
                        sessionId: session._id,
                      })
                    }
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Empty className="py-3">
            <EmptyDescription>{t('noOthers')}</EmptyDescription>
          </Empty>
        )}
      </SettingsBlock>
    </div>

    <AlertDialog
      open={pendingRevocation !== null}
      onOpenChange={(next) => {
        if (!next) setPendingRevocation(null)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {pendingRevocation?.type === 'revoke-others'
              ? t('confirmRevokeOthers')
              : t('confirmRevoke')}
          </AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{ts('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              const pending = pendingRevocation
              setPendingRevocation(null)
              if (!pending) return
              if (pending.type === 'revoke') revokeSession(pending.sessionId)
              else revokeAllOthers()
            }}
          >
            {pendingRevocation?.type === 'revoke-others'
              ? t('revokeAll')
              : t('revoke')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}
