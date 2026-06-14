import { useEffect, useRef } from 'react'

import { fetchSyrnikeConfig } from '#/features/api/config-api'
import { useAuth } from '#/features/auth/auth-context'
import { eventsGateway } from '#/features/events/gateway'
import { syncStore } from '#/features/sync/sync-store'
import type { GatewayServerEvent } from '#/features/sync/types'

import { playUiSound } from './sound-player'
import {
  createSoundEventResolver,
  currentVoiceChannelIdFromParticipants,
} from './sound-event-sequence'
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
  const resolverRef = useRef<ReturnType<typeof createSoundEventResolver> | null>(
    null,
  )

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
    resolverRef.current = createSoundEventResolver(
      syncStore.getState().voiceParticipants,
    )
    const unsubscribe = eventsGateway.subscribeEvents((event) => {
      const resolver =
        resolverRef.current ??
        createSoundEventResolver(syncStore.getState().voiceParticipants)
      resolverRef.current = resolver
      const syncState = syncStore.getState()
      const soundEvents = resolver.resolve(event as GatewayServerEvent, {
          currentUserId: auth.user?._id,
          activeChannelId: activeChannelIdFromPath(),
          currentVoiceChannelId: currentVoiceChannelIdFromParticipants(
            syncState.voiceParticipants,
            auth.user?._id,
          ),
          documentFocused: documentFocused(),
          blockedUserIds: blockedUserIds(),
        })
      for (const soundEvent of soundEvents) playUiSound(soundEvent)
    })

    return () => {
      unsubscribe()
    }
  }, [auth.user?._id])
}
