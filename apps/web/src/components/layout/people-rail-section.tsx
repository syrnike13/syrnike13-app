import { Link } from '@tanstack/react-router'
import type { Channel } from '@syrnike13/api-types'

import { HeadphonesIcon, UsersIcon } from '#/components/icons'
import {
  AvatarNotificationBadge,
  UserAvatar,
} from '#/components/user/user-avatar'
import { useAuth } from '#/features/auth/auth-context'
import { selectChannelNotificationBadge } from '#/features/notifications/notification-selectors'
import {
  getChannelLabel,
  getDmRecipientId,
} from '#/features/sync/channel-label'
import { listVisibleDmRailChannels } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import type { VoiceCallState } from '#/features/sync/voice-types'
import {
  isIncomingVoiceCall,
  isOutgoingVoiceCall,
  isVoiceCallDismissed,
  isVoiceCallRingingDismissed,
} from '#/features/sync/voice-call-utils'
import { cn } from '#/lib/utils'

type PeopleRailVariant = 'desktop' | 'mobile'

function voiceCallMarkerTitleForCall(
  voiceCall: VoiceCallState | undefined,
  dismissedVoiceCallKeys: Record<string, true>,
  currentUserId: string | undefined,
): string | null {
  if (isVoiceCallDismissed(voiceCall, dismissedVoiceCallKeys)) {
    return null
  }
  if (
    !isVoiceCallRingingDismissed(voiceCall, dismissedVoiceCallKeys) &&
    isIncomingVoiceCall(voiceCall, currentUserId)
  ) {
    return 'Входящий звонок'
  }
  if (
    !isVoiceCallRingingDismissed(voiceCall, dismissedVoiceCallKeys) &&
    isOutgoingVoiceCall(voiceCall, currentUserId)
  ) {
    return 'Исходящий звонок'
  }
  if (voiceCall?.phase === 'active') {
    return 'Идёт звонок'
  }
  return null
}

export function PeopleRailSection({
  variant,
  activeChannelId,
}: {
  variant: PeopleRailVariant
  activeChannelId?: string
}) {
  const auth = useAuth()
  const people = useSyncStore((s) =>
    listVisibleDmRailChannels(s, auth.user?._id),
  )

  if (people.length === 0) return null

  return (
    <>
      {people.map((channel) => (
        <PeopleRailButton
          key={channel._id}
          channel={channel}
          variant={variant}
          activeChannelId={activeChannelId}
          currentUserId={auth.user?._id}
        />
      ))}
      <div
        aria-hidden="true"
        className="my-0.5 h-0.5 w-8 shrink-0 rounded-full bg-border"
      />
    </>
  )
}

function PeopleRailButton({
  channel,
  variant,
  activeChannelId,
  currentUserId,
}: {
  channel: Channel
  variant: PeopleRailVariant
  activeChannelId?: string
  currentUserId?: string
}) {
  const users = useSyncStore((s) => s.users)
  const notificationBadge = useSyncStore((s) =>
    selectChannelNotificationBadge(s, channel),
  )
  const callTitle = useSyncStore((s) =>
    voiceCallMarkerTitleForCall(
      s.voiceCalls[channel._id],
      s.dismissedVoiceCallKeys,
      currentUserId,
    ),
  )

  const active = channel._id === activeChannelId
  const label = getChannelLabel(channel, users, currentUserId)
  const dmRecipientId = getDmRecipientId(channel, currentUserId)
  const dmUser = dmRecipientId ? users[dmRecipientId] : undefined
  const channelTo = variant === 'mobile' ? '/m/c/$channelId' : '/app/c/$channelId'
  const title = callTitle ? `${label} — ${callTitle}` : label
  const railNotificationBadge = active ? undefined : notificationBadge

  return (
    <Link
      to={channelTo}
      params={{ channelId: channel._id }}
      search={{ m: undefined }}
      title={title}
      onClick={() => syncStore.setSelectedServerId(null)}
      className={cn(
        'group relative flex shrink-0 items-center justify-center overflow-visible p-0.5',
        'rounded-full outline-none transition-opacity hover:opacity-90',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute -left-1 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-[height,opacity]',
          active ? 'h-8 opacity-100' : 'h-2 opacity-0',
        )}
      />
      {dmUser ? (
        <UserAvatar
          user={dmUser}
          className="size-10"
          fallbackClassName="size-10 text-xs"
          showPresence={false}
          notificationBadge={railNotificationBadge}
          notificationRingClassName="border-background"
          animated="never"
        />
      ) : channel.channel_type === 'Group' ? (
        <span className="relative shrink-0">
          <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <UsersIcon aria-hidden="true" className="size-5" />
          </span>
          {railNotificationBadge ? (
            <AvatarNotificationBadge
              badge={railNotificationBadge}
              className="size-10"
              ringClassName="border-background"
            />
          ) : null}
        </span>
      ) : (
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase text-muted-foreground">
          {label.trim().slice(0, 2) || '??'}
        </span>
      )}
      {callTitle ? (
        <span
          title={callTitle}
          className="absolute -bottom-0.5 -left-0.5 flex size-4 items-center justify-center rounded-full bg-chart-3 text-primary-foreground"
        >
          <HeadphonesIcon aria-hidden="true" className="size-2.5" />
        </span>
      ) : null}
    </Link>
  )
}
