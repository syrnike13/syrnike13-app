import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Loader2Icon } from '#/components/icons'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import { useAuth } from '#/features/auth/auth-context'
import {
  fetchPublicInvite,
  isGroupInviteJoin,
  isServerInviteJoin,
  joinInvite,
} from '#/features/api/invites-api'
import { syncStore } from '#/features/sync/sync-store'
import { loadSession } from '#/lib/session'

export const Route = createFileRoute('/invite/$code')({
  component: InviteJoinPage,
})

function InviteJoinPage() {
  const { code } = Route.useParams()
  const auth = useAuth()
  const navigate = useNavigate()
  const token = auth.session?.token ?? loadSession()?.token

  const inviteQuery = useQuery({
    queryKey: ['invite', code],
    queryFn: () => fetchPublicInvite(code),
  })

  const invite = inviteQuery.data

  async function join() {
    if (!token) {
      await navigate({ to: '/login' })
      return
    }

    try {
      const response = await joinInvite(token, code)
      syncStore.applyInviteJoinResponse(response)
      if (isServerInviteJoin(response)) {
        syncStore.setSelectedServerId(response.server._id)
        const channel = response.channels[0]
        if (channel) {
          await navigate({
            to: '/app/c/$channelId',
            params: { channelId: channel._id },
            search: { m: undefined },
          })
        } else {
          await navigate({ to: '/app', search: { tab: 'online' } })
        }
        toast.success('Вы присоединились к серверу')
        return
      }

      if (isGroupInviteJoin(response)) {
        toast.success('Приглашение принято')
        await navigate({
          to: '/app/c/$channelId',
          params: { channelId: response.channel._id },
          search: { m: undefined },
        })
        return
      }

      toast.error('Неизвестный тип приглашения')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось принять',
      )
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Приглашение</CardTitle>
          <CardDescription>Код: {code}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {inviteQuery.isLoading ? (
            <Loader2Icon className="mx-auto animate-spin" />
          ) : inviteQuery.isError ? (
            <p className="text-sm text-destructive">
              Приглашение не найдено или истекло
            </p>
          ) : invite && 'type' in invite && invite.type === 'Server' ? (
            <div className="space-y-1 text-sm">
              <p className="font-medium">{invite.server_name}</p>
              <p className="text-muted-foreground">
                Канал: {invite.channel_name}
              </p>
              <p className="text-muted-foreground">
                Участников: {invite.member_count}
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Публичное приглашение
            </p>
          )}

          {token ? (
            <Button type="button" onClick={() => void join()}>
              Присоединиться
            </Button>
          ) : (
            <Button asChild>
              <Link to="/login">Войти, чтобы принять</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
