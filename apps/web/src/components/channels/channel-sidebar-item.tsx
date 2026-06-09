import { Link } from '@tanstack/react-router'
import {
  CheckCheckIcon,
  HashIcon,
  LinkIcon,
  SettingsIcon,
  Volume2Icon,
} from 'lucide-react'
import { useState, type MouseEvent } from 'react'
import type { Channel } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { ChannelSettingsDialog } from '#/components/channels/channel-settings-dialog'
import { Badge } from '#/components/ui/badge'
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
import {
  getChannelLabel,
  getDmRecipientId,
} from '#/features/sync/channel-label'
import {
  getChannelLastMessageId,
  isChannelUnread,
} from '#/features/sync/selectors'
import {
  syncStore,
} from '#/features/sync/sync-store'
import { VoiceChannelPreview } from '#/components/voice/voice-channel-preview'
import { canJoinVoiceChannel } from '#/features/voice/voice-api-capability'
import { resolveVoiceChannelClickAction } from '#/features/navigation/voice-channel-click'
import { useVoice } from '#/features/voice/voice-provider'
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
  unreads,
  canManage = false,
  canInvite = false,
  dragHandleProps,
  dragging = false,
}: ChannelSidebarItemProps) {
  const auth = useAuth()
  const voice = useVoice()
  const token = auth.session?.token
  const [settingsOpen, setSettingsOpen] = useState(false)

  const label = getChannelLabel(channel, users, currentUserId)
  const active = channel._id === activeChannelId
  const unread = !active && isChannelUnread(channel, unreads[channel._id])
  const dmRecipientId = getDmRecipientId(channel, currentUserId)
  const dmUser = dmRecipientId ? users[dmRecipientId] : undefined
  const isServerChannel = channel.channel_type === 'TextChannel'
  const serverVoice = isServerVoiceChannel(channel)

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

    if (action === 'none') {
      event.preventDefault()
      return
    }

    if (action === 'join') {
      event.preventDefault()
      void voice.join(channel._id)
      return
    }

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
          'flex h-9 min-w-0 items-center rounded-md text-sm transition-colors',
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
            'flex min-w-0 flex-1 items-center gap-2 px-2 font-normal',
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
          ) : serverVoice ? (
            <Volume2Icon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <HashIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {unread ? (
            <Badge className="size-2 shrink-0 rounded-full p-0" />
          ) : null}
        </Link>
        {canManage && isServerChannel ? (
          <button
            type="button"
            className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover/channel:opacity-100 hover:bg-accent/80 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
