import { useEffect } from 'react'

import { fetchSyrnikeConfig } from '#/features/api/config-api'
import { useAuth } from '#/features/auth/auth-context'
import { eventsGateway } from '#/features/events/gateway'
import { syncStore } from '#/features/sync/sync-store'
import type { GatewayServerEvent } from '#/features/sync/types'

import { soundEventFromGatewayEvent } from './sound-event-map'
import { playUiSound } from './sound-player'
import { soundRuntimeConfigStore } from './sound-runtime-config'

function activeChannelIdFromPath() {
  if (typeof window === 'undefined') return null
  const match = window.location.pathname.match(/\/app\/c\/([^/]+)/)
  return match?.[1] ?? null
}

function documentFocused() {
  return typeof document !== 'undefined' && document.hasFocus()
}

function blockedUserIds() {
  const state = syncStore.getState()
  return new Set(
    Object.values(state.users)
      .filter((user) => user.relationship === 'Blocked')
      .map((user) => user._id),
  )
}

export function useEventSounds() {
  const auth = useAuth()

  useEffect(() => {
    let cancelled = false
    void fetchSyrnikeConfig()
      .then((config) => {
        if (cancelled) return
        soundRuntimeConfigStore.setEventPackId(config.ui_sounds?.event_pack)
      })
      .catch(() => {
        if (!cancelled) soundRuntimeConfigStore.setEventPackId(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const unsubscribe = eventsGateway.subscribeEvents((event) => {
      const soundEvent = soundEventFromGatewayEvent(
        event as GatewayServerEvent,
        {
          currentUserId: auth.user?._id,
          activeChannelId: activeChannelIdFromPath(),
          documentFocused: documentFocused(),
          blockedUserIds: blockedUserIds(),
        },
      )
      if (soundEvent) playUiSound(soundEvent)
    })

    return () => {
      unsubscribe()
    }
  }, [auth.user?._id])
}
