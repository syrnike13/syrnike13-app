import { useNavigate } from '@tanstack/react-router'

import { HeadphonesIcon, PhoneOffIcon } from '#/components/icons'
import { Button } from '#/components/ui/button'
import { UserAvatar } from '#/components/user/user-avatar'
import { useAuth } from '#/features/auth/auth-context'
import { getChannelLabel } from '#/features/sync/channel-label'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import {
  isIncomingVoiceCall,
  isVoiceCallRingingDismissed,
} from '#/features/sync/voice-call-utils'
import { declineDirectMessageCall } from '#/features/api/channels-api'
import { closeVoiceCallNotification } from '#/features/notifications/voice-call-notifications'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { useVoice } from '#/features/voice/voice-context'

type IncomingVoiceCallOverlayProps = {
  activeChannelId?: string
}

export function IncomingVoiceCallOverlay({
  activeChannelId,
}: IncomingVoiceCallOverlayProps) {
  const auth = useAuth()
  const voice = useVoice()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const currentUserId = auth.user?._id
  const currentVoiceSessionChannelId =
    voice.status === 'connected' || voice.status === 'connecting'
      ? voice.channelId
      : null

  const incoming = useSyncStore((state) => {
    if (!currentUserId) return null

    for (const call of Object.values(state.voiceCalls)) {
      if (!isIncomingVoiceCall(call, currentUserId)) continue
      if (call.channelId === activeChannelId) continue
      if (call.channelId === currentVoiceSessionChannelId) continue

      if (isVoiceCallRingingDismissed(call, state.dismissedVoiceCallKeys)) {
        continue
      }

      const channel = state.channels[call.channelId]
      if (!channel) continue

      return {
        call,
        channel,
        initiator: state.users[call.initiatorId],
        channelTitle: getChannelLabel(channel, state.users, currentUserId),
      }
    }

    return null
  })

  if (!incoming) return null

  const { call, channel, channelTitle, initiator } = incoming
  const initiatorName =
    initiator?.display_name ??
    initiator?.username ??
    'Пользователь'
  const token = auth.session?.token
  const title =
    channel.channel_type === 'DirectMessage'
      ? 'Личный звонок'
      : 'Групповой звонок'
  const declineLabel =
    channel.channel_type === 'DirectMessage' ? 'Отклонить' : 'Скрыть'

  function declineIncomingCall() {
    if (channel.channel_type === 'DirectMessage') {
      if (!token || !currentUserId) return
      void declineDirectMessageCall(token, call.channelId)
        .then(() => {
          syncStore.markVoiceCallDeclined(call.channelId, currentUserId)
          void closeVoiceCallNotification(call.channelId)
        })
        .catch(() => undefined)
      return
    }

    syncStore.dismissVoiceCall(call)
    void closeVoiceCallNotification(call.channelId)
  }

  return (
    <div
      className="fixed right-4 bottom-4 z-[120] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-2xl"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 items-center gap-3">
        {initiator ? (
          <UserAvatar
            user={initiator}
            className="size-11"
            fallbackClassName="size-11"
            showPresence
          />
        ) : (
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <HeadphonesIcon className="size-5" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{title}</p>
          <p className="truncate text-sm text-muted-foreground">
            {initiatorName} звонит
          </p>
          {channel.channel_type !== 'DirectMessage' ? (
            <p className="truncate text-xs text-muted-foreground">
              {channelTitle}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          className="flex-1 bg-emerald-600 text-white hover:bg-emerald-600/90"
          onClick={() => {
            void voice
              .join(call.channelId)
              .then((joined) => {
                if (!joined) return
                void navigate({
                  to: `${prefix}/c/$channelId`,
                  params: { channelId: call.channelId },
                  search: { m: undefined },
                })
              })
              .catch(() => undefined)
          }}
        >
          <HeadphonesIcon className="size-4" />
          Ответить
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="flex-1"
          onClick={declineIncomingCall}
        >
          <PhoneOffIcon className="size-4" />
          {declineLabel}
        </Button>
      </div>
    </div>
  )
}
