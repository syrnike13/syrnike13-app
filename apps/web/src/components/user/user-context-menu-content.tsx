import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  BanIcon,
  CheckIcon,
  CopyIcon,
  HeadphonesIcon,
  MessageCircleIcon,
  SettingsIcon,
  UserIcon,
  UserMinusIcon,
} from '#/components/icons'
import type { Member, Server, User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
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
import { FxImage } from '#/components/ui/fx-image'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { FriendshipContextMenuItems } from '#/components/friends/friendship-action'
import { useAuth } from '#/features/auth/auth-context'
import {
  banServerMember,
  editServerMember,
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
import { useVoiceSession } from '#/features/voice/voice-session-context'
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
import { canToggleMemberRole, listServerRoles } from '#/lib/member-roles'
import { roleIconUrl } from '#/lib/media'
import { normalizeRoleColour, roleColourStyle } from '#/lib/server-permissions'
import { cn } from '#/lib/utils'

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

const pendingRoleEditKeys = new Set<string>()

function roleEditKey(serverId: string, userId: string, roleId: string) {
  return `${serverId}:${userId}:${roleId}`
}

function UserRolesContextMenuSub({
  server,
  actorMember,
  actorUserId,
  targetMember,
  token,
}: {
  server: Server
  actorMember: Member | undefined
  actorUserId: string | undefined
  targetMember: Member
  token: string | undefined
}) {
  const roles = useMemo(() => listServerRoles(server), [server])
  const assignedRoleIds = useMemo(
    () => new Set(targetMember.roles ?? []),
    [targetMember.roles],
  )
  const visibleRoles = useMemo(
    () =>
      roles
        .map((role) => {
          const assigned = assignedRoleIds.has(role._id)
          const canAdd = canToggleMemberRole(
            server,
            actorMember,
            actorUserId,
            targetMember,
            role,
            true,
          )
          const canRemove = canToggleMemberRole(
            server,
            actorMember,
            actorUserId,
            targetMember,
            role,
            false,
          )

          return { role, assigned, canAdd, canRemove }
        })
        .filter(({ assigned, canAdd }) => assigned || canAdd),
    [actorMember, actorUserId, assignedRoleIds, roles, server, targetMember],
  )
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null)

  async function toggleRole(roleId: string, enabled: boolean) {
    if (!token || !actorUserId) return

    const role = server.roles?.[roleId]
    if (!role) return
    if (
      !canToggleMemberRole(
        server,
        actorMember,
        actorUserId,
        targetMember,
        role,
        enabled,
      )
    ) {
      return
    }

    const nextRoles = enabled
      ? [...new Set([...(targetMember.roles ?? []), roleId])]
      : (targetMember.roles ?? []).filter((id) => id !== roleId)
    const pendingKey = roleEditKey(server._id, targetMember._id.user, roleId)
    if (pendingRoleEditKeys.has(pendingKey)) return

    pendingRoleEditKeys.add(pendingKey)
    setSavingRoleId(roleId)
    try {
      const updated = await editServerMember(
        token,
        server._id,
        targetMember._id.user,
        { roles: nextRoles },
      )
      syncStore.upsertMembers([updated])
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось обновить роли',
      )
    } finally {
      pendingRoleEditKeys.delete(pendingKey)
      setSavingRoleId(null)
    }
  }

  if (visibleRoles.length === 0) return null

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger className="gap-2 [&>svg:last-child]:hidden">
        <SettingsIcon />
        Роли
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-h-80 w-72 overflow-y-auto">
        {visibleRoles.map(({ role, assigned, canAdd, canRemove }) => {
          const pendingKey = roleEditKey(
            server._id,
            targetMember._id.user,
            role._id,
          )
          const disabled =
            savingRoleId === role._id ||
            pendingRoleEditKeys.has(pendingKey) ||
            (assigned ? !canRemove : !canAdd)
          const iconUrl = roleIconUrl(role.icon)

          return (
            <ContextMenuItem
              key={role._id}
              disabled={disabled}
              className={cn(
                'grid grid-cols-[1rem_minmax(0,1fr)_1rem] gap-2',
                assigned &&
                  disabled &&
                  'data-[disabled]:bg-accent/45 data-[disabled]:opacity-100',
              )}
              onSelect={(event) => {
                event.preventDefault()
                if (!disabled) void toggleRole(role._id, !assigned)
              }}
            >
              {iconUrl ? (
                <FxImage
                  src={iconUrl}
                  rounded="full"
                  wrapperClassName="size-4 shrink-0 self-center"
                  className="size-4"
                />
              ) : (
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <span
                    className="size-2.5 rounded-full bg-muted-foreground"
                    style={
                      role.colour
                        ? { backgroundColor: normalizeRoleColour(role.colour) }
                        : undefined
                    }
                  />
                </span>
              )}
              <span
                className="min-w-0 truncate"
                style={roleColourStyle(role.colour)}
              >
                {role.name}
              </span>
              <span
                data-role-indicator={
                  assigned ? (disabled ? 'locked' : 'assigned') : 'available'
                }
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-[3px] border',
                  assigned && !disabled
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-transparent',
                  assigned &&
                    disabled &&
                    'border-border bg-muted text-muted-foreground',
                )}
              >
                {assigned ? <CheckIcon className="size-3" /> : null}
              </span>
            </ContextMenuItem>
          )
        })}
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}

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
  const voice = useVoiceSession()
  const { openSettings } = useSettingsModal()
  const [kickDialogOpen, setKickDialogOpen] = useState(false)
  const [kickReason, setKickReason] = useState('')
  const [kicking, setKicking] = useState(false)
  const [banDialogOpen, setBanDialogOpen] = useState(false)
  const [banReason, setBanReason] = useState('')
  const [banDeleteMessageSeconds, setBanDeleteMessageSeconds] = useState('0')
  const [banning, setBanning] = useState(false)

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
  const showRoles = Boolean(server && targetMember && !isSelf)

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
    if (!window.confirm(`Заблокировать @${user.username}?`)) return
    try {
      await blockUserRelationship(token, user._id)
    } catch {
      // friend-actions already shows the concrete error toast.
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
      {showRoles && server && targetMember ? (
        <UserRolesContextMenuSub
          server={server}
          actorMember={actorMember}
          actorUserId={auth.user?._id}
          targetMember={targetMember}
          token={token}
        />
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
            onSelect={() => void handleBlock()}
          >
            <BanIcon />
            Заблокировать
          </ContextMenuItem>
        </>
      ) : null}
      </ContextMenuContent>
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
