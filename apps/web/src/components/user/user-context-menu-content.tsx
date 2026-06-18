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
import { FriendshipContextMenuItems } from '#/components/friends/friendship-action'
import { useAuth } from '#/features/auth/auth-context'
import {
  banServerMember,
  kickServerMember,
} from '#/features/api/servers-api'
import { openDirectMessageChannel } from '#/features/dm/dm-actions'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { blockUserRelationship } from '#/features/friends/friend-actions'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { selectDirectMessageCallActionLabel } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { useVoice } from '#/features/voice/voice-context'
import { UserContextMenuVoiceControls } from '#/components/user/user-context-menu-voice-controls'
import { writeClipboardText } from '#/lib/clipboard'
import { serverChannelServerId } from '#/lib/channel-voice'
import {
  canBanServerMember,
  canKickServerMember,
} from '#/lib/permissions'

type UserContextMenuContentProps = {
  user: User
  serverId?: string
  isSelf?: boolean
  /** Пользователь сейчас в голосовом канале — показываем громкость. */
  inVoice?: boolean
  onOpenProfile?: () => void
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
  const voice = useVoice()
  const { openSettings } = useSettingsModal()

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

  async function handleKick() {
    if (!token || !serverId || isSelf) return
    if (!window.confirm(`Исключить @${user.username} с сервера?`)) return
    try {
      await kickServerMember(token, serverId, user._id)
      syncStore.removeServerMember(serverId, user._id)
      toast.success('Участник исключён')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось исключить',
      )
    }
  }

  async function handleBan() {
    if (!token || !serverId || isSelf) return
    if (
      !window.confirm(
        `Забанить @${user.username}? Пользователь не сможет вернуться на сервер.`,
      )
    ) {
      return
    }
    try {
      await banServerMember(token, serverId, user._id)
      syncStore.removeServerMember(serverId, user._id)
      toast.success('Пользователь забанен')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось забанить',
      )
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
              onSelect={() => void handleKick()}
            >
              <UserMinusIcon />
              Исключить с сервера
            </ContextMenuItem>
          ) : null}
          {canBan ? (
            <ContextMenuItem
              variant="destructive"
              onSelect={() => void handleBan()}
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
  )
}
