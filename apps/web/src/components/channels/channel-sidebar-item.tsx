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
import { Button } from '#/components/ui/button'
import {
  FloatingMenu,
  FloatingMenuItem,
} from '#/components/ui/floating-menu'
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
  useSyncStore,
} from '#/features/sync/sync-store'
import { getChannelVoiceParticipantCount } from '#/features/sync/voice-selectors'
import { VoiceChannelPreview } from '#/components/voice/voice-channel-preview'
import { canUseVoiceRestApi } from '#/features/voice/voice-api-capability'
import { useVoice } from '#/features/voice/voice-provider'
import { isServerVoiceChannel } from '#/lib/channel-voice'
import { inviteUrl } from '#/lib/invite-link'
import { cn } from '#/lib/utils'

type ServerChannel = Extract<
  Channel,
  { channel_type: 'TextChannel' | 'VoiceChannel' }
>

type ChannelSidebarItemProps = {
  channel: Channel
  activeChannelId?: string
  users: Record<string, import('@syrnike13/api-types').User>
  currentUserId?: string
  unreads: Record<string, string | null | undefined>
}

export function ChannelSidebarItem({
  channel,
  activeChannelId,
  users,
  currentUserId,
  unreads,
}: ChannelSidebarItemProps) {
  const auth = useAuth()
  const voice = useVoice()
  const token = auth.session?.token
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const label = getChannelLabel(channel, users, currentUserId)
  const active = channel._id === activeChannelId
  const unread = !active && isChannelUnread(channel, unreads[channel._id])
  const dmRecipientId = getDmRecipientId(channel, currentUserId)
  const dmUser = dmRecipientId ? users[dmRecipientId] : undefined
  const isServerChannel =
    channel.channel_type === 'TextChannel' ||
    channel.channel_type === 'VoiceChannel'
  const serverVoice = isServerVoiceChannel(channel)
  const voiceCount = useSyncStore((s) =>
    serverVoice
      ? getChannelVoiceParticipantCount(
          s,
          channel._id,
          currentUserId ?? auth.user?._id,
        )
      : 0,
  )

  function closeMenu() {
    setMenu(null)
  }

  async function markRead() {
    closeMenu()
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
    closeMenu()
    const url = `${window.location.origin}/app/c/${channel._id}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Ссылка скопирована')
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  async function createInvite() {
    closeMenu()
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

  function openSettings() {
    closeMenu()
    setSettingsOpen(true)
  }

  const inThisVoiceSession =
    voice.channelId === channel._id &&
    (voice.status === 'connected' || voice.status === 'connecting')

  /** Как в Discord: 1-й клик — войс без смены канала; 2-й — открыть экран войса. */
  function handleVoiceChannelClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!serverVoice || !canUseVoiceRestApi(channel)) return
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }

    if (!active) {
      if (inThisVoiceSession) {
        return
      }
      event.preventDefault()
      void voice.join(channel._id)
      return
    }

    if (!inThisVoiceSession) {
      void voice.join(channel._id)
    }
  }

  return (
    <>
      <div className="flex flex-col">
        <Button
          variant={active ? 'secondary' : 'ghost'}
          className={cn('h-9 justify-start gap-2 px-2 font-normal')}
          asChild
          onContextMenu={(event) => {
            event.preventDefault()
            setMenu({ x: event.clientX, y: event.clientY })
          }}
        >
          <Link
            to="/app/c/$channelId"
            params={{ channelId: channel._id }}
            search={{ m: undefined }}
            onClick={serverVoice ? handleVoiceChannelClick : undefined}
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
            {serverVoice && voiceCount > 0 ? (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {voiceCount}
              </span>
            ) : null}
            {unread ? (
              <Badge className="size-2 shrink-0 rounded-full p-0" />
            ) : null}
          </Link>
        </Button>
        {serverVoice ? <VoiceChannelPreview channelId={channel._id} /> : null}
      </div>

      <FloatingMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={closeMenu}
      >
        <FloatingMenuItem onClick={() => void markRead()}>
          <CheckCheckIcon className="size-3.5" />
          Прочитано
        </FloatingMenuItem>
        <FloatingMenuItem onClick={() => void copyLink()}>
          <LinkIcon className="size-3.5" />
          Копировать ссылку
        </FloatingMenuItem>
        {channel.channel_type === 'TextChannel' ? (
          <FloatingMenuItem onClick={() => void createInvite()}>
            <LinkIcon className="size-3.5" />
            Приглашение
          </FloatingMenuItem>
        ) : null}
        {isServerChannel ? (
          <FloatingMenuItem onClick={openSettings}>
            <SettingsIcon className="size-3.5" />
            Настройки канала
          </FloatingMenuItem>
        ) : null}
      </FloatingMenu>

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
