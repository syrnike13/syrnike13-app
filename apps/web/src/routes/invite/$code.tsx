import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import { useQuery } from '@tanstack/react-query'
import { Effect } from 'effect'
import { toast } from 'sonner'

import {
  Button,
  buttonVariants,
} from '@syrnike13/ui/primitives/button'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { cn } from '#/lib/utils'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@syrnike13/ui/primitives/card'
import { useAuth } from '#/features/auth/auth-context'
import {
  fetchPublicInvite,
  isGroupInviteJoin,
  isServerInviteJoin,
  joinInviteEffect,
} from '#/features/api/invites-api'
import { syncStore } from '#/features/sync/sync-store'
import { loadSession } from '#/lib/session'
import { apiErrorMessage } from '#/lib/api/error-message'

export const Route = createFileRoute('/invite/$code')({
  component: InviteJoinPage,
})

function InviteJoinPage() {
  const t = useTranslations('invite')
  const { code } = Route.useParams()
  const auth = useAuth()
  const navigate = useNavigate()
  const token = auth.session?.token ?? loadSession()?.token

  const inviteQuery = useQuery({
    queryKey: ['invite', code],
    queryFn: ({ signal }) => fetchPublicInvite(code, signal),
  })

  const invite = inviteQuery.data

  async function join() {
    if (!token) {
      await navigate({ to: '/login' })
      return
    }

    await Effect.runPromise(
      Effect.gen(function*() {
        const response = yield* joinInviteEffect(token, code)
        yield* Effect.sync(() => {
          syncStore.applyInviteJoinResponse(response)
        })

      if (isServerInviteJoin(response)) {
          yield* Effect.sync(() => {
            syncStore.setSelectedServerId(response.server._id)
          })
        const channel = response.channels[0]
        if (channel) {
            yield* Effect.tryPromise({
              try: () =>
                navigate({
                  to: '/c/$channelId',
                  params: { channelId: channel._id },
                  search: { m: undefined },
                }),
              catch: (cause) => cause,
          })
        } else {
            yield* Effect.tryPromise({
              try: () =>
                navigate({ to: '/', search: { tab: 'online' } }),
              catch: (cause) => cause,
            })
        }
          yield* Effect.sync(() =>
            toast.success(t('serverJoined')),
          )
        return
      }

      if (isGroupInviteJoin(response)) {
          yield* Effect.sync(() => toast.success(t('accepted')))
          yield* Effect.tryPromise({
            try: () =>
              navigate({
                to: '/c/$channelId',
                params: { channelId: response.channel._id },
                search: { m: undefined },
              }),
            catch: (cause) => cause,
        })
        return
      }

        yield* Effect.sync(() =>
          toast.error(t('unknown')),
        )
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              apiErrorMessage(error, t('error')),
            )
          }),
        ),
      ),
    )
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('code', { code })}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {inviteQuery.isLoading ? (
            <Spinner className="mx-auto" />
          ) : inviteQuery.isError ? (
            <p className="text-sm text-destructive">{t('notFound')}</p>
          ) : invite && 'type' in invite && invite.type === 'Server' ? (
            <div className="space-y-1 text-sm">
              <p className="font-medium">{invite.server_name}</p>
              <p className="text-muted-foreground">
                {t('channel', { channel: invite.channel_name })}
              </p>
              <p className="text-muted-foreground">
                {t('members', { count: invite.member_count })}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('public')}</p>
          )}

          {token ? (
            <Button type="button" onClick={() => void join()}>
              {t('join')}
            </Button>
          ) : (
            <Link to="/login" className={cn(buttonVariants())}>
              {t('loginToJoin')}
            </Link>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
