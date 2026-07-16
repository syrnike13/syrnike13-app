import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Invite } from '@syrnike13/api-types'
import { CopyIcon, PlusIcon } from '#/components/icons'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { ServerInviteDialog } from '#/components/servers/server-invite-dialog'
import { useAuth } from '#/features/auth/auth-context'
import { fetchServerInvites } from '#/features/api/servers-api'
import {
  deleteInvite,
  getInviteInactiveReason,
  type InviteInactiveReason,
} from '#/features/api/invites-api'
import { listServerChannels } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { writeClipboardText } from '#/lib/clipboard'
import { inviteUrl } from '#/lib/invite-link'

type ServerSettingsInvitesPanelProps = {
  serverId: string
}

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
  if (timestamp == null) return 'Без срока'
  return formatInviteTimestamp(timestamp)
}

function formatInviteUses(invite: Invite) {
  const maxUses = invite.max_uses && invite.max_uses > 0 ? invite.max_uses : '∞'
  return `${invite.uses} / ${maxUses}`
}

const INACTIVE_INVITE_LABELS: Record<InviteInactiveReason, string> = {
  revoked: 'Отозвано',
  expired: 'Истекло',
  exhausted: 'Использовано',
}

export function ServerSettingsInvitesPanel({
  serverId,
}: ServerSettingsInvitesPanelProps) {
  const auth = useAuth()
  const token = auth.session?.token
  const channels = useSyncStore((s) =>
    listServerChannels(s, serverId, auth.user?._id),
  )
  const users = useSyncStore((s) => s.users)
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false)
  const [revokingCode, setRevokingCode] = useState<string | null>(null)
  const [revokeReason, setRevokeReason] = useState('')
  const [invitePendingRevocation, setInvitePendingRevocation] =
    useState<string | null>(null)

  const invitesQuery = useQuery({
    queryKey: ['server-invites', serverId],
    enabled: Boolean(token),
    queryFn: () => fetchServerInvites(token!, serverId),
  })

  const invites = invitesQuery.data ?? []
  const channelNamesById = new Map(
    channels.map((channel) => [channel._id, channel.name]),
  )

  async function revokeInvite() {
    if (!token || !invitePendingRevocation) return

    const code = invitePendingRevocation
    const body = revokeReason.trim() ? { reason: revokeReason.trim() } : {}

    setRevokingCode(code)
    try {
      await deleteInvite(token, code, body)
      await invitesQuery.refetch()
      setInvitePendingRevocation(null)
      setRevokeReason('')
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

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-3 border-b border-border/60 pb-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-base font-semibold">Приглашения</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Управляйте активными ссылками сервера.
          </p>
        </div>
        <Button
          type="button"
          className="w-fit"
          onClick={() => setInviteDialogOpen(true)}
        >
          <PlusIcon className="size-4" />
          Создать приглашение
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
            const inactiveReason = getInviteInactiveReason(invite)
            const inactiveLabel = inactiveReason
              ? INACTIVE_INVITE_LABELS[inactiveReason]
              : null
            const revoked = inactiveReason === 'revoked'
            const inactive = inactiveReason !== null
            const channelLabel = `#${
              channelNamesById.get(invite.channel) ?? invite.channel
            }`
            const creator = users[invite.creator]
            const creatorLabel =
              creator?.display_name || creator?.username || invite.creator
            const revoker = invite.revoked_by
              ? users[invite.revoked_by]
              : undefined
            const revokerLabel =
              revoker?.display_name ||
              revoker?.username ||
              invite.revoked_by ||
              'Неизвестно'

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
                    {inactiveLabel ? (
                      <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {inactiveLabel}
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
                  {invite.revoked_at ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Отозвал: {revokerLabel} · Отозвано:{' '}
                      {formatInviteTimestamp(invite.revoked_at)}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Копировать ${invite._id}`}
                    disabled={inactive}
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
                    onClick={() => setInvitePendingRevocation(invite._id)}
                  >
                    Отозвать
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <Dialog
        open={invitePendingRevocation !== null}
        onOpenChange={(open) => {
          if (!open && revokingCode === null) {
            setInvitePendingRevocation(null)
            setRevokeReason('')
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Отозвать приглашение {invitePendingRevocation}?
            </DialogTitle>
            <DialogDescription>
              Ссылка перестанет принимать новых участников.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5 py-2">
            <Label htmlFor="invite-revoke-reason">Причина отзыва</Label>
            <Input
              id="invite-revoke-reason"
              value={revokeReason}
              maxLength={512}
              disabled={revokingCode !== null}
              onChange={(event) => setRevokeReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={revokingCode !== null}
              onClick={() => {
                setInvitePendingRevocation(null)
                setRevokeReason('')
              }}
            >
              Отмена
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={revokingCode !== null}
              onClick={() => void revokeInvite()}
            >
              Отозвать приглашение
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ServerInviteDialog
        serverId={serverId}
        open={inviteDialogOpen}
        onOpenChange={(open) => {
          setInviteDialogOpen(open)
          if (!open) void invitesQuery.refetch()
        }}
      />
    </div>
  )
}
