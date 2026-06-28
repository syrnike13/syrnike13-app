import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DataCreateInvite, Invite, User } from '@syrnike13/api-types'
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  HashIcon,
  SearchIcon,
} from '#/components/icons'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Label } from '#/components/ui/label'
import { UserAvatar } from '#/components/user/user-avatar'
import { useAuth } from '#/features/auth/auth-context'
import { sendChannelMessage } from '#/features/api/messages-api'
import { fetchServerInvites } from '#/features/api/servers-api'
import { openDirectMessage } from '#/features/api/users-api'
import { createChannelInvite } from '#/features/api/invites-api'
import {
  listServerChannels,
  listUsersByRelationship,
} from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import {
  canInviteToChannel,
  ChannelPermission,
  calculateServerPermissions,
  hasChannelPermission,
} from '#/lib/permissions'
import { writeClipboardText } from '#/lib/clipboard'
import { inviteUrl } from '#/lib/invite-link'
import { cn } from '#/lib/utils'

type ServerInviteDialogProps = {
  serverId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

const INVITE_MAX_AGE_OPTIONS = [
  { label: '1 час', value: '3600' },
  { label: '1 день', value: '86400' },
  { label: '7 дней', value: '604800' },
  { label: '30 дней', value: '2592000' },
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

function userLabel(user: User) {
  return user.display_name ?? user.username
}

function inviteCode(invite: Invite) {
  return '_id' in invite ? invite._id : ''
}

function activeInvite(invites: Invite[], channelId?: string) {
  return invites.find((invite) => {
    if (!('_id' in invite) || !invite._id) return false
    if ('revoked_at' in invite && invite.revoked_at) return false
    if (channelId && 'channel' in invite && invite.channel !== channelId) {
      return false
    }
    return true
  })
}

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

  const [busyUserId, setBusyUserId] = useState<string | null>(null)
  const [creatingLink, setCreatingLink] = useState(false)
  const [sentUserIds, setSentUserIds] = useState<string[]>([])
  const [friendSearch, setFriendSearch] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [invites, setInvites] = useState<Invite[]>([])
  const [activeInviteCode, setActiveInviteCode] = useState('')
  const [maxAgeSeconds, setMaxAgeSeconds] = useState('2592000')
  const [maxUses, setMaxUses] = useState('0')
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
  const activeChannelName =
    textChannels.find((channel) => channel._id === activeChannelId)?.name ??
    'канал'
  const friends = useSyncStore((s) =>
    listUsersByRelationship(s, 'Friend', auth.user?._id).filter(
      (user) => !user.bot,
    ),
  )
  const visibleFriends = useMemo(() => {
    const query = friendSearch.trim().toLocaleLowerCase('ru-RU')
    if (!query) return friends
    return friends.filter((user) => {
      const text = `${user.display_name ?? ''} ${user.username}`
      return text.toLocaleLowerCase('ru-RU').includes(query)
    })
  }, [friendSearch, friends])
  const currentInviteUrl = activeInviteCode ? inviteUrl(activeInviteCode) : ''

  const loadInvites = useCallback(async () => {
    if (!token || !canManageServer) return

    try {
      const loadedInvites = await fetchServerInvites(token, serverId)
      setInvites(loadedInvites)

      const existing =
        activeInvite(loadedInvites, activeChannelId) ?? activeInvite(loadedInvites)
      if (existing) {
        setActiveInviteCode(inviteCode(existing))
        if ('channel' in existing) {
          setSelectedChannelId(existing.channel)
        }
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось загрузить',
      )
    }
  }, [activeChannelId, canManageServer, serverId, token])

  useEffect(() => {
    if (!open) return
    setFriendSearch('')
    setSentUserIds([])
    void loadInvites()
  }, [loadInvites, open])

  function invalidateLink() {
    setActiveInviteCode('')
  }

  async function ensureInviteLink() {
    if (currentInviteUrl) return currentInviteUrl

    if (!token || !activeChannelId) {
      throw new Error('Нет текстового канала для приглашения')
    }

    setCreatingLink(true)
    try {
      const body: DataCreateInvite = {
        max_age_seconds: Number(maxAgeSeconds),
        max_uses: Number(maxUses),
      }
      const invite = await createChannelInvite(token, activeChannelId, body)
      const code = inviteCode(invite)

      if (!code) {
        throw new Error('Сервер не вернул код приглашения')
      }

      const nextInvite = { ...invite, channel: invite.channel ?? activeChannelId }
      setInvites((current) => [nextInvite, ...current])
      setActiveInviteCode(code)
      return inviteUrl(code)
    } finally {
      setCreatingLink(false)
    }
  }

  async function copyInviteLink() {
    try {
      const url = await ensureInviteLink()
      await writeClipboardText(url)
      toast.success('Ссылка скопирована')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось скопировать',
      )
    }
  }

  async function inviteFriend(user: User) {
    if (!token) return

    setBusyUserId(user._id)
    try {
      const url = await ensureInviteLink()
      const channel = await openDirectMessage(token, user._id)
      syncStore.upsertChannel(channel)
      const message = await sendChannelMessage(token, channel._id, {
        content: `Приглашение на сервер ${server?.name ?? 'сервер'}: ${url}`,
      })
      syncStore.upsertMessage(message)
      setSentUserIds((current) =>
        current.includes(user._id) ? current : [...current, user._id],
      )
      toast.success('Приглашение отправлено')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось пригласить',
      )
    } finally {
      setBusyUserId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[440px]">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>Пригласить друзей в {server?.name ?? 'сервер'}</DialogTitle>
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            Участники окажутся в{' '}
            <span className="inline-flex items-center gap-1 text-foreground">
              <HashIcon className="size-3.5" />
              {activeChannelName}
            </span>
          </p>
        </DialogHeader>

        <div className="px-5 pb-4">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={friendSearch}
              onChange={(event) => setFriendSearch(event.target.value)}
              placeholder="Найти друзей"
              className="h-10 w-full rounded-md border border-input bg-background pr-3 pl-9 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
        </div>

        <div className="min-h-48 px-4 pb-4">
          <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
            Участники сервера
          </p>
          {visibleFriends.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Друзья не найдены
            </p>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto pr-1">
              {visibleFriends.map((user) => {
                const sent = sentUserIds.includes(user._id)
                const busy = busyUserId === user._id
                const label = userLabel(user)

                return (
                  <li key={user._id}>
                    <div className="flex items-center gap-3 rounded-md px-1 py-1.5">
                      <UserAvatar user={user} className="size-8 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">
                          {label}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {user.username}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant={sent ? 'secondary' : 'default'}
                        disabled={busy || sent || creatingLink || !activeChannelId}
                        aria-label={`Пригласить ${label}`}
                        onClick={() => void inviteFriend(user)}
                      >
                        {sent ? (
                          <>
                            <CheckIcon className="size-4" />
                            Отправлено
                          </>
                        ) : busy ? (
                          'Отправка...'
                        ) : (
                          'Пригласить'
                        )}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="border-t bg-muted/20 px-5 py-4">
          <p className="mb-2 text-sm font-semibold">
            Или отправьте другу ссылку-приглашение на сервер
          </p>
          <div className="flex gap-2">
            <div className="flex h-10 min-w-0 flex-1 items-center rounded-md border border-input bg-background px-3 text-sm">
              <span
                className={cn(
                  'truncate',
                  !currentInviteUrl && 'text-muted-foreground',
                )}
              >
                {currentInviteUrl || 'Ссылка будет создана при копировании'}
              </span>
            </div>
            <Button
              type="button"
              disabled={creatingLink || !activeChannelId}
              onClick={() => void copyInviteLink()}
            >
              <CopyIcon className="size-4" />
              Копировать
            </Button>
          </div>
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            onClick={() => setSettingsOpen((current) => !current)}
          >
            Изменить ссылку-приглашение
            <ChevronDownIcon
              className={cn(
                'size-3.5 transition-transform',
                settingsOpen && 'rotate-180',
              )}
            />
          </button>

          {settingsOpen ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {inviteChannels.length > 0 ? (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="server-invite-channel">
                    Канал приглашения
                  </Label>
                  <select
                    id="server-invite-channel"
                    value={activeChannelId ?? ''}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    onChange={(event) => {
                      setSelectedChannelId(event.target.value)
                      invalidateLink()
                    }}
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
                  onChange={(event) => {
                    setMaxAgeSeconds(event.target.value)
                    invalidateLink()
                  }}
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
                  onChange={(event) => {
                    setMaxUses(event.target.value)
                    invalidateLink()
                  }}
                >
                  {INVITE_MAX_USES_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
