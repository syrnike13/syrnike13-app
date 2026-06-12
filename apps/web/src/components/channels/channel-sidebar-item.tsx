import { Link, useMatch, useNavigate } from '@tanstack/react-router'
import {
  CheckCheckIcon,
  HashIcon,
  HeadphonesIcon,
  LinkIcon,
  SettingsIcon,
  Trash2Icon,
  UsersIcon,
} from '#/components/icons'
import type { MouseEvent } from 'react'
import type { Channel } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { NotificationBadge } from '#/components/notifications/notification-badge'
import { VoiceChannelIcon } from '#/components/icons/voice-channel-icon'
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
import { deleteChannel } from '#/features/api/channels-api'
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
import { getChannelLastMessageId, pickDefaultChannelId } from '#/features/sync/selectors'
import {
  syncStore,
  useSyncStore,
} from '#/features/sync/sync-store'
import { VoiceChannelPreview } from '#/components/voice/voice-channel-preview'
import { canJoinVoiceChannel } from '#/features/voice/voice-api-capability'
import { resolveVoiceChannelClickAction } from '#/features/navigation/voice-channel-click'
import { useVoice } from '#/features/voice/voice-context'
import { isServerVoiceChannel } from '#/lib/channel-voice'
import { canManageChannel } from '#/lib/permissions'
import { channelSettingsSearch } from '#/lib/channel-settings-navigation'
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
  const channelRouteMatch = useMatch({
    from: '/app/c/$channelId',
    shouldThrow: false,
  })
  const server = useSyncStore((s) =>
    channel.channel_type === 'TextChannel' ? s.servers[channel.server] : undefined,
  )
  const member = useSyncStore((s) =>
    channel.channel_type === 'TextChannel' && auth.user?._id
      ? s.members[`${channel.server}:${auth.user._id}`]
      : undefined,
  )
  const canDeleteChannel = canManageChannel(
    server,
    channel,
    member,
    auth.user?._id,
  )

  function openChannelSettings() {
    const hostChannelId = activeChannelId ?? channel._id
    void navigate({
      to: '/app/c/$channelId',
      params: { channelId: hostChannelId },
      search: channelSettingsSearch({
        settingsChannel: channel._id,
        settingsTab: 'overview',
        m: channelRouteMatch?.search?.m,
      }),
    })
  }

  async function handleDeleteChannel() {
    if (!token || !canDeleteChannel) return
    if (
      !window.confirm(
        `Удалить канал «${channel.name}»? Это действие необратимо.`,
      )
    ) {
      return
    }

    try {
      await deleteChannel(token, channel._id)
      syncStore.removeChannel(channel._id)
      toast.success('Канал удалён')

      const settingsChannelId = channelRouteMatch?.search?.settingsChannel
      const viewingDeletedChannel =
        channelRouteMatch?.params.channelId === channel._id ||
        settingsChannelId === channel._id

      if (!viewingDeletedChannel) return

      const fallback = pickDefaultChannelId(
        syncStore.getState(),
        auth.user?._id,
      )
      if (fallback) {
        await navigate({
          to: '/app/c/$channelId',
          params: { channelId: fallback },
          search: { m: undefined },
        })
      } else {
        await navigate({ to: '/app', search: { tab: 'online' } })
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось удалить канал',
      )
    }
  }

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
            <VoiceChannelIcon channel={channel} server={server} />
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
              openChannelSettings()
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
          <ContextMenuItem onSelect={openChannelSettings}>
            <SettingsIcon className="size-3.5" />
            Настройки канала
          </ContextMenuItem>
        </>
      ) : null}
      {canDeleteChannel && isServerChannel ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onSelect={() => void handleDeleteChannel()}
          >
            <Trash2Icon className="size-3.5" />
            Удалить канал
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
    </>
  )
}
