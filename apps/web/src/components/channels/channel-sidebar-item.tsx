import { Link, useNavigate } from '@tanstack/react-router'
import {
  CheckCheckIcon,
  HashIcon,
  HeadphonesIcon,
  LinkIcon,
  SettingsIcon,
  UsersIcon,
  Volume2BoldIcon,
} from '#/components/icons'
import { useState, type MouseEvent } from 'react'
import type { Channel } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { ChannelSettingsDialog } from '#/components/channels/channel-settings-dialog'
import { NotificationBadge } from '#/components/notifications/notification-badge'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '#/components/ui/context-menu'
import { UserAvatar } from '#/components/user/user-avatar'
import { useAuth } from '#/features/auth/auth-context'
import { ackChannel } from '#/features/api/sync-api'
import { createChannelInvite } from '#/features/api/servers-api'
import { selectChannelNotificationBadge } from '#/features/notifications/notification-selectors'
import {
  getChannelLabel,
  getDmRecipientId,
} from '#/features/sync/channel-label'
import {
  isIncomingVoiceCall,
  isVoiceCallDismissed,
  isVoiceCallRingingDismissed,
} from '#/features/sync/voice-call-utils'
import { getChannelLastMessageId } from '#/features/sync/selectors'
import {
  syncStore,
  useSyncStore,
} from '#/features/sync/sync-store'
import { VoiceChannelPreview } from '#/components/voice/voice-channel-preview'
import { canJoinVoiceChannel } from '#/features/voice/voice-api-capability'
import { resolveVoiceChannelClickAction } from '#/features/navigation/voice-channel-click'
import { useVoice } from '#/features/voice/voice-context'
import { isServerVoiceChannel } from '#/lib/channel-voice'
import { inviteUrl } from '#/lib/invite-link'
import { publicAppUrl } from '#/lib/public-origin'
import { cn } from '#/lib/utils'

type ServerChannel = Extract<Channel, { channel_type: 'TextChannel' }>

type ChannelSidebarItemProps = {
  channel: Channel
  activeChannelId?: string
  users: Record<string, import('@syrnike13/api-types').User>
  currentUserId?: string
  unreads: Record<string, string | null | undefined>
  canManage?: boolean
  canInvite?: boolean
  dragHandleProps?: Record<string, unknown>
  dragging?: boolean
}

export function ChannelSidebarItem({
  channel,
  activeChannelId,
  users,
  currentUserId,
  unreads: _unreads,
  canManage = false,
  canInvite = false,
  dragHandleProps,
  dragging = false,
}: ChannelSidebarItemProps) {
  const auth = useAuth()
  const voice = useVoice()
  const navigate = useNavigate()
  const token = auth.session?.token
  const [settingsOpen, setSettingsOpen] = useState(false)

  const label = getChannelLabel(channel, users, currentUserId)
  const active = channel._id === activeChannelId
  const notificationBadge = useSyncStore((s) =>
    selectChannelNotificationBadge(s, channel),
  )
  const voiceCall = useSyncStore((s) => s.voiceCalls[channel._id])
  const voiceCallDismissed = useSyncStore((s) =>
    isVoiceCallDismissed(voiceCall, s.dismissedVoiceCallKeys),
  )
  const voiceCallRingingDismissed = useSyncStore((s) =>
    isVoiceCallRingingDismissed(voiceCall, s.dismissedVoiceCallKeys),
  )
  const dmRecipientId = getDmRecipientId(channel, currentUserId)
  const dmUser = dmRecipientId ? users[dmRecipientId] : undefined
  const isServerChannel = channel.channel_type === 'TextChannel'
  const serverVoice = isServerVoiceChannel(channel)
  const incomingVoiceCall =
    !voiceCallRingingDismissed && isIncomingVoiceCall(voiceCall, currentUserId)
  const voiceCallMarkerTitle =
    voiceCallDismissed
      ? null
      : incomingVoiceCall
        ? 'Входящий звонок'
        : voiceCall?.phase === 'active'
          ? 'Идёт звонок'
          : null

  async function markRead() {
    if (!token) return
    const lastId = getChannelLastMessageId(channel)
    if (!lastId) return
    syncStore.setChannelLastRead(channel._id, lastId)
    try {
      await ackChannel(token, channel._id, lastId)
      toast.success('Канал отмечен прочитанным')
    } catch {
      toast.error('Не удалось отметить прочитанным')
    }
  }

  async function copyLink() {
    const url = publicAppUrl(`/app/c/${channel._id}`)
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Ссылка скопирована')
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  async function createInvite() {
    if (!token || channel.channel_type !== 'TextChannel') return
    try {
      const invite = await createChannelInvite(token, channel._id)
      const code = '_id' in invite ? invite._id : ''
      if (code) {
        await navigator.clipboard.writeText(inviteUrl(code))
        toast.success('Приглашение скопировано')
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось создать',
      )
    }
  }

  function handleVoiceChannelClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!serverVoice || !canJoinVoiceChannel(channel)) return
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }

    const action = resolveVoiceChannelClickAction({
      clickedChannelId: channel._id,
      currentRouteChannelId: activeChannelId,
      voiceChannelId: voice.channelId,
      voiceStatus: voice.status,
    })

    event.preventDefault()
    void navigate({
      to: '/app/c/$channelId',
      params: { channelId: channel._id },
      search: { m: undefined },
    })

    if (action === 'join-and-open') {
      void voice.join(channel._id)
    }
  }

  const row = (
    <div
      className={cn(
        'group/channel flex flex-col',
        dragging && 'opacity-60',
      )}
      data-channel-sidebar-item=""
    >
      <div
        className={cn(
          'flex h-9 min-w-0 items-stretch rounded-md text-sm transition-colors',
          active
            ? 'bg-secondary text-secondary-foreground'
            : 'text-foreground hover:bg-accent hover:text-accent-foreground',
        )}
      >
        <Link
          to="/app/c/$channelId"
          params={{ channelId: channel._id }}
          search={{ m: undefined }}
          className={cn(
            'flex h-full min-w-0 flex-1 items-center gap-2 px-2 font-normal',
            canManage &&
              dragHandleProps &&
              'cursor-grab touch-none active:cursor-grabbing',
          )}
          onClick={serverVoice ? handleVoiceChannelClick : undefined}
          {...(canManage && dragHandleProps ? dragHandleProps : {})}
        >
          {channel.channel_type === 'DirectMessage' && dmUser ? (
            <UserAvatar
              user={dmUser}
              className="size-6"
              fallbackClassName="size-6 text-[10px]"
            />
          ) : channel.channel_type === 'Group' ? (
            <span
              title="Групповой чат"
              className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
            >
              <UsersIcon aria-hidden="true" className="size-4" />
            </span>
          ) : serverVoice ? (
            <Volume2BoldIcon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <HashIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {voiceCallMarkerTitle ? (
            <span
              title={voiceCallMarkerTitle}
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-600/15 text-emerald-500"
            >
              <HeadphonesIcon aria-hidden="true" className="size-3.5" />
            </span>
          ) : null}
          {!active ? (
            <NotificationBadge badge={notificationBadge} mode="dot" />
          ) : null}
        </Link>
        {canManage && isServerChannel ? (
          <button
            type="button"
            className="mr-1 flex size-6 shrink-0 self-center items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover/channel:opacity-100 hover:bg-accent/80 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            title="Настройки канала"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setSettingsOpen(true)
            }}
          >
            <SettingsIcon className="size-3.5" />
          </button>
        ) : null}
      </div>
      {serverVoice ? <VoiceChannelPreview channelId={channel._id} /> : null}
    </div>
  )

  const menuItems = (
    <>
      <ContextMenuItem onSelect={() => void markRead()}>
        <CheckCheckIcon className="size-3.5" />
        Прочитано
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void copyLink()}>
        <LinkIcon className="size-3.5" />
        Копировать ссылку
      </ContextMenuItem>
      {channel.channel_type === 'TextChannel' && canInvite ? (
        <ContextMenuItem onSelect={() => void createInvite()}>
          <LinkIcon className="size-3.5" />
          Приглашение
        </ContextMenuItem>
      ) : null}
      {canManage && isServerChannel ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setSettingsOpen(true)}>
            <SettingsIcon className="size-3.5" />
            Настройки канала
          </ContextMenuItem>
        </>
      ) : null}
    </>
  )

  return (
    <>
      {isServerChannel ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          <ContextMenuContent className="w-52">{menuItems}</ContextMenuContent>
        </ContextMenu>
      ) : (
        row
      )}

      {isServerChannel ? (
        <ChannelSettingsDialog
          channel={channel as ServerChannel}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      ) : null}
    </>
  )
}
