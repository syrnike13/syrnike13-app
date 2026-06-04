import { useEffect, useRef } from 'react'

import { useAuth } from '#/features/auth/auth-context'
import { eventsGateway } from '#/features/events/gateway'
import { refreshChannelVoiceState } from '#/features/voice/refresh-channel-voice-state'

const WS_DEBOUNCE_MS = 800

function channelIdFromVoiceEvent(event: {
  id?: string
  channel?: string
  channel_id?: string
}) {
  return event.channel ?? event.channel_id ?? event.id
}

function voiceEventTouchesChannel(event: { type: string }, channelId: string) {
  if (event.type === 'VoiceChannelMove') {
    const move = event as { from?: string; to?: string }
    return move.from === channelId || move.to === channelId
  }

  if (event.type === 'UserVoiceStateUpdate') {
    const update = event as { channel_id?: string; channel?: string; id?: string }
    return (update.channel_id ?? update.channel) === channelId
  }

  if (
    event.type !== 'VoiceChannelJoin' &&
    event.type !== 'VoiceChannelLeave'
  ) {
    return false
  }

  return (
    channelIdFromVoiceEvent(
      event as { id?: string; channel?: string; channel_id?: string },
    ) === channelId
  )
}

export function useChannelVoiceState(channelId: string, enabled = true) {
  const auth = useAuth()
  const token = auth.session?.token
  const wsRefreshTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled || !token || !channelId) return

    let active = true

    function load() {
      if (!active) return
      void refreshChannelVoiceState(token, channelId)
    }

    load()

    const unsubscribe = eventsGateway.subscribeState((state) => {
      if (state === 'connected') load()
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [channelId, enabled, token])

  useEffect(() => {
    if (!enabled || !token || !channelId) return

    function scheduleRefresh() {
      if (wsRefreshTimerRef.current !== null) {
        window.clearTimeout(wsRefreshTimerRef.current)
      }
      wsRefreshTimerRef.current = window.setTimeout(() => {
        wsRefreshTimerRef.current = null
        void refreshChannelVoiceState(token, channelId)
      }, WS_DEBOUNCE_MS)
    }

    const unsubscribe = eventsGateway.subscribeEvents((event) => {
      if (voiceEventTouchesChannel(event, channelId)) {
        scheduleRefresh()
      }
    })

    return () => {
      unsubscribe()
      if (wsRefreshTimerRef.current !== null) {
        window.clearTimeout(wsRefreshTimerRef.current)
        wsRefreshTimerRef.current = null
      }
    }
  }, [channelId, enabled, token])
}
