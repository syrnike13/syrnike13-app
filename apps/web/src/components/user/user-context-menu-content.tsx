import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  BanIcon,
  CopyIcon,
  HeadphonesIcon,
  MessageCircleIcon,
  SettingsIcon,
  UserIcon,
  UserMinusIcon,
} from '#/components/icons'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '#/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { FriendshipContextMenuItems } from '#/components/friends/friendship-action'
import { EditMemberRolesDialog } from '#/components/servers/edit-member-roles-dialog'
import { useAuth } from '#/features/auth/auth-context'
import {
  banServerMember,
  kickServerMember,
} from '#/features/api/servers-api'
import { openDirectMessageChannel } from '#/features/dm/dm-actions'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { blockUserRelationship } from '#/features/friends/friend-actions'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import {
  listServerChannels,
  selectDirectMessageCallActionLabel,
} from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { useVoice } from '#/features/voice/voice-context'
import { UserContextMenuVoiceControls } from '#/components/user/user-context-menu-voice-controls'
import { writeClipboardText } from '#/lib/clipboard'
import {
  isServerVoiceChannel,
  serverChannelServerId,
} from '#/lib/channel-voice'
import {
  canBanServerMember,
  canKickServerMember,
} from '#/lib/permissions'
import { canEditAnyMemberRole } from '#/lib/member-roles'

type UserContextMenuContentProps = {
  user: User
  serverId?: string
  isSelf?: boolean
  /** Пользователь сейчас в голосовом канале — показываем громкость. */
  inVoice?: boolean
  onOpenProfile?: () => void
}

const BAN_DELETE_MESSAGE_PRESETS = [
  { label: 'Не удалять', seconds: 0 },
  { label: '1 час', seconds: 60 * 60 },
  { label: '24 часа', seconds: 24 * 60 * 60 },
  { label: '7 дней', seconds: 7 * 24 * 60 * 60 },
]

export function UserContextMenuContent({
  user,
  serverId,
  isSelf = false,
  inVoice = false,
  onOpenProfile,
}: UserContextMenuContentProps) {
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const voice = useVoice()
  const { openSettings } = useSettingsModal()
  const [rolesDialogOpen, setRolesDialogOpen] = useState(false)
  const [kickDialogOpen, setKickDialogOpen] = useState(false)
  const [kickReason, setKickReason] = useState('')
  const [kicking, setKicking] = useState(false)
  const [banDialogOpen, setBanDialogOpen] = useState(false)
  const [banReason, setBanReason] = useState('')
  const [banDeleteMessageSeconds, setBanDeleteMessageSeconds] = useState('0')
  const [banning, setBanning] = useState(false)
  const [blockDialogOpen, setBlockDialogOpen] = useState(false)
  const [blocking, setBlocking] = useState(false)

  const server = useSyncStore((s) =>
    serverId ? s.servers[serverId] : undefined,
  )
  const actorMember = useSyncStore((s) =>
    serverId && auth.user?._id
      ? s.members[`${serverId}:${auth.user._id}`]
      : undefined,
  )
  const targetMember = useSyncStore((s) =>
    serverId ? s.members[`${serverId}:${user._id}`] : undefined,
  )
  const targetVoiceChannelId = useSyncStore((s) => {
    if (!serverId) return undefined
    for (const [channelId, channelMap] of Object.entries(s.voiceParticipants)) {
      if (!channelMap[user._id]) continue
      if (serverChannelServerId(s.channels[channelId]) === serverId) {
        return channelId
      }
    }
    return undefined
  })
  const moveVoiceChannels = useSyncStore((s) =>
    serverId
      ? listServerChannels(s, serverId, auth.user?._id).filter(
          isServerVoiceChannel,
        )
      : [],
  )
  const directCallActionLabel = useSyncStore((s) =>
    selectDirectMessageCallActionLabel(s, auth.user?._id, user._id),
  )

  const canKick =
    server &&
    canKickServerMember(server, actorMember, auth.user?._id, targetMember)
  const canBan =
    server &&
    canBanServerMember(server, actorMember, auth.user?._id, targetMember)
  const canBlock = !isSelf
  const canDirectMessage = !isSelf && !user.bot
  const canEditRoles = Boolean(
    server &&
      targetMember &&
      !isSelf &&
      canEditAnyMemberRole(server, actorMember, auth.user?._id, targetMember),
  )

  const token = auth.session?.token

  async function openDm() {
    if (!token || !canDirectMessage) return
    try {
      await openDirectMessageChannel(token, user._id, (channelId) =>
        navigate({
          to: `${prefix}/c/$channelId`,
          params: { channelId },
          search: { m: undefined },
        }),
      )
    } catch {
      // dm-actions already shows the concrete error toast.
    }
  }

  async function startDirectCall() {
    if (!token || !canDirectMessage) return
    try {
      const channel = await openDirectMessageChannel(token, user._id, (channelId) =>
        navigate({
          to: `${prefix}/c/$channelId`,
          params: { channelId },
          search: { m: undefined },
        }),
      )
      await voice.join(channel._id)
    } catch {
      // dm-actions already shows the concrete error toast.
    }
  }

  function handleKickDialogOpenChange(open: boolean) {
    setKickDialogOpen(open)
    if (!open) {
      setKickReason('')
    }
  }

  async function handleKick() {
    if (!token || !serverId || isSelf || !canKick) return

    const body = kickReason.trim() ? { reason: kickReason.trim() } : {}

    setKicking(true)
    try {
      await kickServerMember(token, serverId, user._id, body)
      syncStore.removeServerMember(serverId, user._id)
      handleKickDialogOpenChange(false)
      toast.success('Участник исключён')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось исключить',
      )
    } finally {
      setKicking(false)
    }
  }

  function handleBanDialogOpenChange(open: boolean) {
    setBanDialogOpen(open)
    if (!open) {
      setBanReason('')
      setBanDeleteMessageSeconds('0')
    }
  }

  async function handleBan() {
    if (!token || !serverId || isSelf || !canBan) return

    const selectedDeleteMessageSeconds = Number(banDeleteMessageSeconds)
    const body = {
      ...(banReason.trim() ? { reason: banReason.trim() } : {}),
      ...(selectedDeleteMessageSeconds > 0
        ? { delete_message_seconds: selectedDeleteMessageSeconds }
        : {}),
    }

    setBanning(true)
    try {
      await banServerMember(token, serverId, user._id, body)
      syncStore.removeServerMember(serverId, user._id)
      handleBanDialogOpenChange(false)
      toast.success('Пользователь забанен')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось забанить',
      )
    } finally {
      setBanning(false)
    }
  }

  async function handleBlock() {
    if (!token || isSelf) return

    setBlocking(true)
    try {
      await blockUserRelationship(token, user._id)
      setBlockDialogOpen(false)
    } catch {
      // friend-actions already shows the concrete error toast.
    } finally {
      setBlocking(false)
    }
  }

  async function copyUserId() {
    try {
      await writeClipboardText(user._id)
      toast.success('ID скопирован')
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  const showVoiceControls = inVoice && !isSelf
  const showModeration = canKick || canBan

  return (
    <>
      <ContextMenuContent className="z-[200] w-56">
      {showVoiceControls ? (
        <UserContextMenuVoiceControls
          userId={user._id}
          token={token}
          server={server}
          actorMember={actorMember}
          actorUserId={auth.user?._id}
          targetMember={targetMember}
          voiceChannelId={targetVoiceChannelId}
          moveVoiceChannels={moveVoiceChannels}
        />
      ) : null}
      <ContextMenuItem onSelect={() => onOpenProfile?.()}>
        <UserIcon />
        Профиль
      </ContextMenuItem>
      {isSelf ? (
        <ContextMenuItem onSelect={() => openSettings('account')}>
          <SettingsIcon />
          Настройки аккаунта
        </ContextMenuItem>
      ) : canDirectMessage ? (
        <>
          <ContextMenuItem onSelect={() => void openDm()}>
            <MessageCircleIcon />
            Написать сообщение
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void startDirectCall()}>
            <HeadphonesIcon />
            {directCallActionLabel}
          </ContextMenuItem>
          <FriendshipContextMenuItems user={user} />
        </>
      ) : null}
      {canEditRoles ? (
        <ContextMenuItem
          onSelect={(event) => {
            event.preventDefault()
            setRolesDialogOpen(true)
          }}
        >
          <SettingsIcon />
          Роли
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem onSelect={() => void copyUserId()}>
        <CopyIcon />
        Копировать ID
      </ContextMenuItem>
      {showModeration ? (
        <>
          <ContextMenuSeparator />
          {canKick ? (
            <ContextMenuItem
              variant="destructive"
              onSelect={(event) => {
                event.preventDefault()
                setKickDialogOpen(true)
              }}
            >
              <UserMinusIcon />
              Исключить с сервера
            </ContextMenuItem>
          ) : null}
          {canBan ? (
            <ContextMenuItem
              variant="destructive"
              onSelect={(event) => {
                event.preventDefault()
                setBanDialogOpen(true)
              }}
            >
              <BanIcon />
              Забанить на сервере
            </ContextMenuItem>
          ) : null}
        </>
      ) : null}
      {canBlock ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onSelect={(event) => {
              event.preventDefault()
              setBlockDialogOpen(true)
            }}
          >
            <BanIcon />
            Заблокировать
          </ContextMenuItem>
        </>
      ) : null}
      </ContextMenuContent>
      {server && targetMember ? (
        <EditMemberRolesDialog
          server={server}
          targetMember={targetMember}
          targetUser={user}
          open={rolesDialogOpen}
          onOpenChange={setRolesDialogOpen}
        />
      ) : null}
      {canKick ? (
        <Dialog open={kickDialogOpen} onOpenChange={handleKickDialogOpenChange}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Исключить @{user.username}</DialogTitle>
              <DialogDescription>
                Пользователь сможет вернуться, если получит новое приглашение.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5 py-2">
              <Label htmlFor={`kick-reason-${user._id}`}>
                Причина исключения
              </Label>
              <Input
                id={`kick-reason-${user._id}`}
                value={kickReason}
                maxLength={256}
                disabled={kicking}
                onChange={(event) => setKickReason(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={kicking}
                onClick={() => handleKickDialogOpenChange(false)}
              >
                Отмена
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={kicking}
                onClick={() => void handleKick()}
              >
                Исключить
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {canBlock ? (
        <Dialog
          open={blockDialogOpen}
          onOpenChange={(open) => {
            if (!blocking) setBlockDialogOpen(open)
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Заблокировать @{user.username}?</DialogTitle>
              <DialogDescription>
                Пользователь не сможет писать вам сообщения и отправлять заявки
                в друзья.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={blocking}
                onClick={() => setBlockDialogOpen(false)}
              >
                Отмена
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={blocking}
                onClick={() => void handleBlock()}
              >
                Заблокировать
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {canBan ? (
        <Dialog open={banDialogOpen} onOpenChange={handleBanDialogOpenChange}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Забанить @{user.username}</DialogTitle>
              <DialogDescription>
                Пользователь не сможет вернуться на сервер, пока бан не снимут.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-1.5">
                <Label htmlFor={`ban-reason-${user._id}`}>Причина</Label>
                <Input
                  id={`ban-reason-${user._id}`}
                  value={banReason}
                  maxLength={256}
                  disabled={banning}
                  onChange={(event) => setBanReason(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`ban-delete-messages-${user._id}`}>
                  Удалить историю сообщений
                </Label>
                <select
                  id={`ban-delete-messages-${user._id}`}
                  value={banDeleteMessageSeconds}
                  className="h-9 w-full rounded-md border border-input bg-muted/40 px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-border dark:bg-secondary dark:text-secondary-foreground"
                  disabled={banning}
                  onChange={(event) =>
                    setBanDeleteMessageSeconds(event.target.value)
                  }
                >
                  {BAN_DELETE_MESSAGE_PRESETS.map((preset) => (
                    <option key={preset.seconds} value={String(preset.seconds)}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={banning}
                onClick={() => handleBanDialogOpenChange(false)}
              >
                Отмена
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={banning}
                onClick={() => void handleBan()}
              >
                Забанить
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}
