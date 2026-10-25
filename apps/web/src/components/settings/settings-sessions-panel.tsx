import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { MonitorIcon, Trash2Icon } from '#/components/icons'
import { Effect } from 'effect'
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@syrnike13/ui/primitives/item'
import { ulidToDate } from '#/lib/ulid'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { useAuth } from '#/features/auth/auth-context'
import {
  deleteSessionEffect,
  fetchSessions,
  revokeOtherSessionsEffect,
} from '#/features/api/sessions-api'
import { loadSession } from '#/lib/session'

/** Session ids are ULIDs: the creation time is in the id. */
function formatSessionDate(sessionId: string, locale: AppLocale) {
  const date = ulidToDate(sessionId)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(locale)
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
          onFailure: () =>
            Effect.sync(() => {
            }),
          onSuccess: () =>
            Effect.sync(() => {
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
          onFailure: () =>
            Effect.sync(() => {
            }),
          onSuccess: () =>
            Effect.sync(() => {
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
          <Item size="sm">
            <ItemMedia variant="icon">
              <MonitorIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{current.name || t('thisDevice')}</ItemTitle>
              <ItemDescription>
                {t('created', { date: formatSessionDate(current._id, locale) })}
              </ItemDescription>
            </ItemContent>
          </Item>
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
            <ItemGroup className="gap-0">
              {others.map((session) => (
                <Item key={session._id} size="sm">
                  <ItemMedia variant="icon">
                    <MonitorIcon />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{session.name || t('session')}</ItemTitle>
                    <ItemDescription>
                      {formatSessionDate(session._id, locale)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      type="button"
                      variant="destructive"
                      size="icon-sm"
                      title={t('revoke')}
                      aria-label={t('revoke')}
                      onClick={() =>
                        setPendingRevocation({
                          type: 'revoke',
                          sessionId: session._id,
                        })
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
            <Button
              type="button"
              variant="destructive"
              className="self-start"
              onClick={() => setPendingRevocation({ type: 'revoke-others' })}
            >
              {t('revokeAll')}
            </Button>
          </>
        ) : (
          <Empty size="sm">
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
