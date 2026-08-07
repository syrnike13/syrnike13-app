import { useEffect, useRef } from 'react'
import { Effect, Fiber } from 'effect'

import { fetchSyrnikeConfigEffect } from '#/features/api/config-api'
import { useAuth } from '#/features/auth/auth-context'
import { eventsGateway } from '#/features/events/gateway'
import { syncStore } from '#/features/sync/sync-store'

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
    const fiber = Effect.runFork(
      fetchSyrnikeConfigEffect().pipe(
        Effect.matchEffect({
          onFailure: () =>
            Effect.sync(() => {
              soundRuntimeConfigStore.setEventPackId(null)
            }),
          onSuccess: (config) =>
            Effect.sync(() => {
              soundRuntimeConfigStore.setEventPackId(
                config.ui_sounds?.event_pack,
              )
            }),
        }),
      ),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])

  useEffect(() => {
    resolverRef.current = createSoundEventResolver(
      syncStore.getState().voiceParticipants,
    )
    const unsubscribe = eventsGateway.subscribeServerEvents((event) => {
      const resolver =
        resolverRef.current ??
        createSoundEventResolver(syncStore.getState().voiceParticipants)
      resolverRef.current = resolver
      const syncState = syncStore.getState()
      const soundEvents = resolver.resolve(event, {
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
