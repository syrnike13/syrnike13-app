import { Link } from '@tanstack/react-router'
import { HashIcon, HeadphonesIcon, UsersIcon } from '#/components/icons'

import { NotificationBadge } from '#/components/notifications/notification-badge'
import { Button } from '#/components/ui/button'
import { UserAvatar } from '#/components/user/user-avatar'
import { useAuth } from '#/features/auth/auth-context'
import { selectChannelNotificationBadge } from '#/features/notifications/notification-selectors'
import { getChannelLabel, getDmRecipientId } from '#/features/sync/channel-label'
import { listDmChannels } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import {
  isIncomingVoiceCall,
  isVoiceCallDismissed,
  isVoiceCallRingingDismissed,
} from '#/features/sync/voice-call-utils'
import { cn } from '#/lib/utils'

type DmChannelListProps = {
  activeChannelId?: string
  className?: string
}

export function DmChannelList({ activeChannelId, className }: DmChannelListProps) {
  const auth = useAuth()
  const syncState = useSyncStore((s) => s)
  const ready = syncState.ready
  const users = syncState.users
  const dmChannels = listDmChannels(syncState, auth.user?._id)

  if (!ready) {
    return (
      <p className={cn('px-2 py-2 text-xs text-muted-foreground', className)}>
        Синхронизация…
      </p>
    )
  }

  if (dmChannels.length === 0) {
    return (
      <p className={cn('px-2 py-2 text-xs text-muted-foreground', className)}>
        Нет личных сообщений
      </p>
    )
  }

  return (
    <nav className={cn('flex flex-col gap-0.5', className)}>
      {dmChannels.map((channel) => {
        const label = getChannelLabel(channel, users, auth.user?._id)
        const active = channel._id === activeChannelId
        const notificationBadge = selectChannelNotificationBadge(
          syncState,
          channel,
        )
        const dmRecipientId = getDmRecipientId(channel, auth.user?._id)
        const dmUser = dmRecipientId ? users[dmRecipientId] : undefined
        const voiceCall = syncState.voiceCalls[channel._id]
        const voiceCallDismissed = isVoiceCallDismissed(
          voiceCall,
          syncState.dismissedVoiceCallKeys,
        )
        const voiceCallRingingDismissed = isVoiceCallRingingDismissed(
          voiceCall,
          syncState.dismissedVoiceCallKeys,
        )
        const incomingVoiceCall =
          !voiceCallRingingDismissed &&
          isIncomingVoiceCall(voiceCall, auth.user?._id)
        const voiceCallMarkerTitle =
          voiceCallDismissed
            ? null
            : incomingVoiceCall
              ? 'Входящий звонок'
              : voiceCall?.phase === 'active'
                ? 'Идёт звонок'
                : null

        return (
          <Button
            key={channel._id}
            variant={active ? 'secondary' : 'ghost'}
            className="h-9 justify-start gap-2 px-2 font-normal"
            asChild
          >
            <Link
              to="/app/c/$channelId"
              params={{ channelId: channel._id }}
              search={{ m: undefined }}
            >
              {dmUser ? (
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
          </Button>
        )
      })}
    </nav>
  )
}
