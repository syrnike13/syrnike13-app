import { Link, useNavigate } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'
import { HashIcon, HeadphonesIcon, UsersIcon, XIcon } from '#/components/icons'

import { NotificationBadge } from '#/components/notifications/notification-badge'
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@syrnike13/ui/primitives/sidebar'
import { UserAvatar } from '#/components/user/user-avatar'
import { deleteChannelEffect } from '@syrnike13/client/api/channels-api'
import { useAuth } from '#/features/auth/auth-context'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { selectChannelNotificationBadge } from '#/features/notifications/notification-selectors'
import { getChannelLabel, getDmRecipientId } from '@syrnike13/client/sync/channel-label'
import { listDmChannels } from '@syrnike13/client/sync/selectors'
import { syncStore, useSyncStore } from '@syrnike13/client/sync/sync-store'
import {
  isIncomingVoiceCall,
  isVoiceCallRingingDismissed,
} from '@syrnike13/client/sync/voice-call-utils'
import { attachmentPreviewUrl } from '#/lib/media'
import { cn } from '#/lib/utils'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'

type DmChannelListProps = {
  activeChannelId?: string
  className?: string
}

export function DmChannelList({ activeChannelId, className }: DmChannelListProps) {
  const t = useTranslations('home.dm')
  const tVoice = useTranslations('layout.voice')
  const tChannel = useTranslations('channels.channelItem')
  const tChat = useTranslations('chat')
  const tSidebar = useTranslations('home.sidebar')
  const auth = useAuth()
  const prefix = useAppRoutePrefix()
  const navigate = useNavigate()
  const syncState = useSyncStore((s) => s)
  const ready = syncState.ready
  const users = syncState.users
  const dmChannels = listDmChannels(syncState, auth.user?._id)
  const token = auth.session?.token

  function closeDirectMessage(channelId: string) {
    if (!token) return

    void Effect.runPromise(
      Effect.gen(function*() {
        yield* deleteChannelEffect(token, channelId)
        yield* Effect.sync(() => syncStore.removeChannel(channelId))
        if (channelId !== activeChannelId) return
        yield* Effect.tryPromise({
          try: () => navigate({ to: prefix || '/', search: { tab: 'online' } }),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => console.error('[dm-list] close failed', error)),
        ),
      ),
    )
  }

  if (!ready) {
    return (
      <p className={cn('px-2 py-2 text-xs text-muted-foreground', className)}>
        {t('syncing')}
      </p>
    )
  }

  if (dmChannels.length === 0) {
    return (
      <Empty size="sm" className={className}>
        <EmptyDescription>{t('empty')}</EmptyDescription>
      </Empty>
    )
  }

  return (
    <nav aria-label={tSidebar('directMessages')} className={className}>
      <SidebarMenu>
        {dmChannels.map((channel) => {
          const label = getChannelLabel(channel, users, auth.user?._id, tChat)
          const active = channel._id === activeChannelId
          const notificationBadge = selectChannelNotificationBadge(
            syncState,
            channel,
          )
          const dmRecipientId = getDmRecipientId(channel, auth.user?._id)
          const dmUser = dmRecipientId ? users[dmRecipientId] : undefined
          const voiceCall = syncState.voiceCalls[channel._id]
          const voiceCallRingingDismissed = isVoiceCallRingingDismissed(
            voiceCall,
            syncState.dismissedVoiceCallKeys,
          )
          const incomingVoiceCall =
            !voiceCallRingingDismissed &&
            isIncomingVoiceCall(voiceCall, auth.user?._id)
          const voiceCallMarkerTitle =
            voiceCall?.phase === 'active'
              ? tVoice('activeCall')
              : incomingVoiceCall
                ? tVoice('incomingCall')
                : null
  
          return (
            <SidebarMenuItem key={channel._id}>
              <SidebarMenuButton
                size="lg"
                isActive={active}
                data-avatar-hover-scope=""
                render={
                  <Link
                    to={`${prefix}/c/$channelId`}
                    params={{ channelId: channel._id }}
                    search={{ m: undefined }}
                  />
                }
              >
                {dmUser ? (
                  <UserAvatar
                    user={dmUser}
                    className="size-8"
                    fallbackClassName="size-8 text-xs"
                    hoverScope="parent"
                  />
                ) : channel.channel_type === 'Group' ? (
                  channel.icon ? (
                    <img
                      src={attachmentPreviewUrl(channel.icon)}
                      alt=""
                      className="size-8 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <span
                      title={tChannel('groupChat')}
                      className="flex size-8 shrink-0 items-center justify-center text-muted-foreground"
                    >
                      <UsersIcon aria-hidden="true" className="size-5" />
                    </span>
                  )
                ) : (
                  <HashIcon className="size-5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {voiceCallMarkerTitle ? (
                  <span
                    title={voiceCallMarkerTitle}
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"
                  >
                    <HeadphonesIcon aria-hidden="true" className="size-4" />
                  </span>
                ) : null}
                {!active ? (
                  <NotificationBadge
                    badge={notificationBadge}
                    mode={notificationBadge.urgent ? 'count' : 'dot'}
                  />
                ) : null}
              </SidebarMenuButton>
              {channel.channel_type === 'DirectMessage' ? (
                <SidebarMenuAction
                  showOnHover
                  aria-label={t('close')}
                  title={t('close')}
                  onClick={() => closeDirectMessage(channel._id)}
                >
                  <XIcon aria-hidden="true" />
                </SidebarMenuAction>
              ) : null}
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </nav>
  )
}
