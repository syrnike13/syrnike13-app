import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DataCreateInvite } from '@syrnike13/api-types'
import { Link2Icon, Trash2Icon } from '#/components/icons'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Label } from '#/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { useAuth } from '#/features/auth/auth-context'
import {
  fetchServerInvites,
} from '#/features/api/servers-api'
import { createChannelInvite, deleteInvite } from '#/features/api/invites-api'
import { listServerChannels } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import {
  canInviteToChannel,
  ChannelPermission,
  calculateServerPermissions,
  hasChannelPermission,
} from '#/lib/permissions'
import { writeClipboardText } from '#/lib/clipboard'
import { inviteUrl } from '#/lib/invite-link'

type ServerInviteDialogProps = {
  serverId: string
  open: boolean
  onOpenChange: (open: boolean) => void
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

export function ServerInviteDialog({
  serverId,
  open,
  onOpenChange,
}: ServerInviteDialogProps) {
  const auth = useAuth()
  const token = auth.session?.token
  const server = useSyncStore((s) => s.servers[serverId])
  const member = useSyncStore((s) => s.members[`${serverId}:${auth.user?._id}`])
  const canManageServer = server
    ? hasChannelPermission(
        calculateServerPermissions(server, member, auth.user?._id),
        ChannelPermission.ManageServer,
      )
    : false
  const [loading, setLoading] = useState(false)
  const [codes, setCodes] = useState<string[]>([])
  const [maxAgeSeconds, setMaxAgeSeconds] = useState('604800')
  const [maxUses, setMaxUses] = useState('0')
  const [temporary, setTemporary] = useState(false)
  const [selectedChannelId, setSelectedChannelId] = useState<string | undefined>()

  const textChannels = useSyncStore((s) =>
    listServerChannels(s, serverId, auth.user?._id).filter(
      (channel) => channel.channel_type === 'TextChannel',
    ),
  )
  const inviteChannels = useMemo(
    () =>
      server
        ? textChannels.filter((channel) =>
            canInviteToChannel(server, channel, member, auth.user?._id),
          )
        : [],
    [auth.user?._id, member, server, textChannels],
  )
  const defaultChannelId = inviteChannels[0]?._id
  const activeChannelId =
    selectedChannelId &&
    inviteChannels.some((channel) => channel._id === selectedChannelId)
      ? selectedChannelId
      : defaultChannelId

  const loadInvites = useCallback(async () => {
    if (!token || !canManageServer) return
    setLoading(true)
    try {
      const invites = await fetchServerInvites(token, serverId)
      setCodes(
        invites
          .map((invite) => ('_id' in invite ? invite._id : ''))
          .filter(Boolean),
      )
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось загрузить',
      )
    } finally {
      setLoading(false)
    }
  }, [canManageServer, serverId, token])

  useEffect(() => {
    if (open) void loadInvites()
  }, [loadInvites, open])

  async function createInvite() {
    if (!token || !activeChannelId) {
      toast.error('Нет текстового канала для приглашения')
      return
    }

    setLoading(true)
    try {
      const body: DataCreateInvite = {
        max_age_seconds: Number(maxAgeSeconds),
        max_uses: Number(maxUses),
        temporary,
      }
      const invite = await createChannelInvite(token, activeChannelId, body)
      const code = '_id' in invite ? invite._id : ''
      if (code) {
        setCodes((current) => [code, ...current])
        await writeClipboardText(inviteUrl(code))
        toast.success('Ссылка скопирована в буфер')
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось создать',
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Приглашения на сервер</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {inviteChannels.length > 0 ? (
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="server-invite-channel">
                  Канал приглашения
                </Label>
                <select
                  id="server-invite-channel"
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
              <Label htmlFor="server-invite-max-age">Срок действия</Label>
              <select
                id="server-invite-max-age"
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
              <Label htmlFor="server-invite-max-uses">
                Максимум использований
              </Label>
              <select
                id="server-invite-max-uses"
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

            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={temporary}
                className="size-4 rounded border-border"
                onChange={(event) => setTemporary(event.target.checked)}
              />
              Временное членство
            </label>
          </div>
          <Button
            type="button"
            disabled={loading || !activeChannelId}
            onClick={() => void createInvite()}
          >
            Создать и скопировать ссылку
          </Button>
          {!canManageServer ? (
            <p className="text-sm text-muted-foreground">
              Список приглашений доступен только администраторам сервера.
            </p>
          ) : codes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {loading ? 'Загрузка…' : 'Приглашений пока нет'}
            </p>
          ) : (
            <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto text-sm">
              {codes.map((code) => (
                <li
                  key={code}
                  className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                >
                  <code className="min-w-0 flex-1 truncate text-xs">
                    {inviteUrl(code)}
                  </code>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => {
                      void writeClipboardText(inviteUrl(code))
                        .then(() => toast.success('Скопировано'))
                        .catch(() => toast.error('Не удалось скопировать'))
                    }}
                  >
                    <Link2Icon className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => {
                      if (!token) return
                      void deleteInvite(token, code)
                        .then(() =>
                          setCodes((current) =>
                            current.filter((entry) => entry !== code),
                          ),
                        )
                        .catch((error) =>
                          toast.error(
                            error instanceof Error
                              ? error.message
                              : 'Ошибка',
                          ),
                        )
                    }}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
