import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DataCreateInvite, Invite } from '@syrnike13/api-types'
import { CopyIcon } from '#/components/icons'
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
import { writeClipboardText } from '#/lib/clipboard'
import { inviteUrl } from '#/lib/invite-link'

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

function formatInviteTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function formatInviteDate(timestamp?: number | null) {
  if (!timestamp) return 'Без срока'
  return formatInviteTimestamp(timestamp)
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
  const users = useSyncStore((s) => s.users)
  const [maxAgeSeconds, setMaxAgeSeconds] = useState('604800')
  const [maxUses, setMaxUses] = useState('0')
  const [temporary, setTemporary] = useState(false)
  const [reason, setReason] = useState('')
  const [selectedChannelId, setSelectedChannelId] = useState<
    string | undefined
  >()
  const [creating, setCreating] = useState(false)
  const [revokingCode, setRevokingCode] = useState<string | null>(null)
  const inviteChannels = server
    ? channels.filter((channel) =>
        canInviteToChannel(server, channel, member, auth.user?._id),
      )
    : []
  const defaultChannelId = inviteChannels[0]?._id
  const activeChannelId =
    selectedChannelId &&
    inviteChannels.some((channel) => channel._id === selectedChannelId)
      ? selectedChannelId
      : defaultChannelId

  const invitesQuery = useQuery({
    queryKey: ['server-invites', serverId],
    enabled: Boolean(token),
    queryFn: () => fetchServerInvites(token!, serverId),
  })

  async function createInvite() {
    if (!token || !activeChannelId) return

    const body: DataCreateInvite = {
      max_age_seconds: Number(maxAgeSeconds),
      max_uses: Number(maxUses),
      temporary,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    }

    setCreating(true)
    try {
      await createChannelInvite(token, activeChannelId, body)
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
    if (!window.confirm(`Отозвать приглашение ${code}?`)) return

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

  async function copyInvite(code: string) {
    try {
      await writeClipboardText(inviteUrl(code))
      toast.success('Скопировано')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Не удалось скопировать приглашение',
      )
    }
  }

  const invites = invitesQuery.data ?? []
  const channelNamesById = new Map(
    channels.map((channel) => [channel._id, channel.name]),
  )

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
          {inviteChannels.length > 0 ? (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="invite-channel">Канал приглашения</Label>
              <select
                id="invite-channel"
                value={activeChannelId ?? ''}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                onChange={(event) => setSelectedChannelId(event.target.value)}
              >
                {inviteChannels.map((channel) => (
                  <option key={channel._id} value={channel._id}>
                    #{channel.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

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
          disabled={creating || !activeChannelId}
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
            const channelLabel = `#${
              channelNamesById.get(invite.channel) ?? invite.channel
            }`
            const creator = users[invite.creator]
            const creatorLabel =
              creator?.display_name || creator?.username || invite.creator
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
                    {invite.temporary ? (
                      <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        Временное
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {channelLabel} · Использования: {formatInviteUses(invite)} · Истекает:{' '}
                    {formatInviteDate(invite.expires_at)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Создал: {creatorLabel} · Создано:{' '}
                    {formatInviteTimestamp(invite.created_at)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Копировать ${invite._id}`}
                    disabled={revoked}
                    onClick={() => void copyInvite(invite._id)}
                  >
                    <CopyIcon className="size-3.5" />
                    Копировать
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={revoked || revokingCode === invite._id}
                    onClick={() => void revokeInvite(invite._id)}
                  >
                    Отозвать
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
