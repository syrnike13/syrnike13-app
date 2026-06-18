import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DataCreateInvite, Invite } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { useAuth } from '#/features/auth/auth-context'
import { fetchServerInvites } from '#/features/api/servers-api'
import { createChannelInvite, deleteInvite } from '#/features/api/invites-api'
import { listServerChannels } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { canInviteToChannel } from '#/lib/permissions'

type ServerSettingsInvitesPanelProps = {
  serverId: string
}

const INVITE_MAX_AGE_OPTIONS = [
  { label: '1 час', value: '3600' },
  { label: '1 день', value: '86400' },
  { label: '7 дней', value: '604800' },
  { label: 'Без срока', value: '0' },
]

const INVITE_MAX_USES_OPTIONS = [
  { label: 'Без лимита', value: '0' },
  { label: '1', value: '1' },
  { label: '5', value: '5' },
  { label: '10', value: '10' },
  { label: '25', value: '25' },
  { label: '100', value: '100' },
]

function formatInviteDate(timestamp?: number | null) {
  if (!timestamp) return 'Без срока'
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function formatInviteUses(invite: Invite) {
  const maxUses = invite.max_uses && invite.max_uses > 0 ? invite.max_uses : '∞'
  return `${invite.uses} / ${maxUses}`
}

export function ServerSettingsInvitesPanel({
  serverId,
}: ServerSettingsInvitesPanelProps) {
  const auth = useAuth()
  const token = auth.session?.token
  const server = useSyncStore((s) => s.servers[serverId])
  const member = useSyncStore((s) =>
    auth.user?._id ? s.members[`${serverId}:${auth.user._id}`] : undefined,
  )
  const channels = useSyncStore((s) =>
    listServerChannels(s, serverId, auth.user?._id),
  )
  const inviteChannel = server
    ? channels.find((channel) =>
        canInviteToChannel(server, channel, member, auth.user?._id),
      )
    : undefined
  const [maxAgeSeconds, setMaxAgeSeconds] = useState('604800')
  const [maxUses, setMaxUses] = useState('0')
  const [temporary, setTemporary] = useState(false)
  const [reason, setReason] = useState('')
  const [creating, setCreating] = useState(false)
  const [revokingCode, setRevokingCode] = useState<string | null>(null)

  const invitesQuery = useQuery({
    queryKey: ['server-invites', serverId],
    enabled: Boolean(token),
    queryFn: () => fetchServerInvites(token!, serverId),
  })

  async function createInvite() {
    if (!token || !inviteChannel) return

    const body: DataCreateInvite = {
      max_age_seconds: Number(maxAgeSeconds),
      max_uses: Number(maxUses),
      temporary,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    }

    setCreating(true)
    try {
      await createChannelInvite(token, inviteChannel._id, body)
      setReason('')
      await invitesQuery.refetch()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось создать приглашение',
      )
    } finally {
      setCreating(false)
    }
  }

  async function revokeInvite(code: string) {
    if (!token) return

    setRevokingCode(code)
    try {
      await deleteInvite(token, code)
      await invitesQuery.refetch()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось отозвать приглашение',
      )
    } finally {
      setRevokingCode(null)
    }
  }

  const invites = invitesQuery.data ?? []

  return (
    <div className="space-y-6">
      <section className="space-y-4 border-b border-border/60 pb-6">
        <div>
          <h3 className="text-base font-semibold">Приглашения</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Создание и отзыв ссылок приглашения.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="invite-max-age">Срок</Label>
            <select
              id="invite-max-age"
              value={maxAgeSeconds}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              onChange={(event) => setMaxAgeSeconds(event.target.value)}
            >
              {INVITE_MAX_AGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-max-uses">Использований</Label>
            <select
              id="invite-max-uses"
              value={maxUses}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              onChange={(event) => setMaxUses(event.target.value)}
            >
              {INVITE_MAX_USES_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={temporary}
              className="size-4 rounded border-border"
              onChange={(event) => setTemporary(event.target.checked)}
            />
            Временное членство
          </label>

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="invite-reason">Причина</Label>
            <Input
              id="invite-reason"
              value={reason}
              maxLength={256}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>

        <Button
          type="button"
          disabled={creating || !inviteChannel}
          onClick={() => void createInvite()}
        >
          Создать
        </Button>
      </section>

      {invitesQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Загрузка...</p>
      ) : invitesQuery.error ? (
        <p className="text-sm text-destructive">
          Не удалось загрузить приглашения.
        </p>
      ) : invites.length === 0 ? (
        <p className="text-sm text-muted-foreground">Приглашений пока нет</p>
      ) : (
        <ul className="space-y-2">
          {invites.map((invite) => {
            const revoked = Boolean(invite.revoked_at)
            return (
              <li
                key={invite._id}
                className="flex flex-col gap-3 rounded-md border border-border px-3 py-2.5 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold">
                      {invite._id}
                    </p>
                    {revoked ? (
                      <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        Отозвано
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Использования: {formatInviteUses(invite)} · Истекает:{' '}
                    {formatInviteDate(invite.expires_at)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={revoked || revokingCode === invite._id}
                  onClick={() => void revokeInvite(invite._id)}
                >
                  Отозвать
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
