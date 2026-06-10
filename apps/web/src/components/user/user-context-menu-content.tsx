import { useNavigate } from '@tanstack/react-router'
import {
  BanIcon,
  CopyIcon,
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
import { useAuth } from '#/features/auth/auth-context'
import {
  banServerMember,
  kickServerMember,
} from '#/features/api/servers-api'
import { blockUser, openDirectMessage } from '#/features/api/users-api'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { syncStore } from '#/features/sync/sync-store'
import { UserContextMenuVoiceControls } from '#/components/user/user-context-menu-voice-controls'

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
  const { openSettings } = useSettingsModal()

  const canModerate = Boolean(serverId) && !isSelf
  const token = auth.session?.token

  async function openDm() {
    if (!token || isSelf) return
    try {
      const channel = await openDirectMessage(token, user._id)
      syncStore.upsertChannel(channel)
      await navigate({
        to: '/app/c/$channelId',
        params: { channelId: channel._id },
        search: { m: undefined },
      })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось открыть ЛС',
      )
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
      const updated = await blockUser(token, user._id)
      syncStore.upsertUser(updated)
      toast.success('Пользователь заблокирован')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось заблокировать',
      )
    }
  }

  async function copyUserId() {
    try {
      await navigator.clipboard.writeText(user._id)
      toast.success('ID скопирован')
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  const showVoiceControls = inVoice && !isSelf

  return (
    <ContextMenuContent className="z-[200] w-56">
      {showVoiceControls ? (
        <UserContextMenuVoiceControls userId={user._id} />
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
      ) : (
        <ContextMenuItem onSelect={() => void openDm()}>
          <MessageCircleIcon />
          Написать сообщение
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => void copyUserId()}>
        <CopyIcon />
        Копировать ID
      </ContextMenuItem>
      {canModerate ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onSelect={() => void handleKick()}
          >
            <UserMinusIcon />
            Исключить с сервера
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onSelect={() => void handleBan()}
          >
            <BanIcon />
            Забанить на сервере
          </ContextMenuItem>
        </>
      ) : null}
      {!isSelf ? (
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
