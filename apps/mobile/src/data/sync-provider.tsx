import { ensureVoiceUsersLoaded } from '@syrnike13/client/sync/ensure-voice-users'
import { refreshSyncAfterReconnect } from '@syrnike13/client/sync/refresh-sync-after-reconnect'
import { syncStore, useSyncReady } from '@syrnike13/client/sync/sync-store'
import { normalizeUserVoiceState } from '@syrnike13/client/sync/voice-event-utils'
import { Effect, Fiber } from 'effect'
import { useEffect, useRef, type ReactNode } from 'react'

import { WS_URL } from '../config'
import { eventsGateway } from './gateway'

/**
 * Keeps the shared sync store (servers, channels, users, messages, voice) in
 * step with the gateway for one signed-in session, like the web SyncProvider.
 */
export function SyncProvider({
  token,
  userId,
  children,
}: {
  token: string
  userId: string
  children: ReactNode
}) {
  const ready = useSyncReady()
  const prevStateRef = useRef(eventsGateway.state)

  useEffect(() => {
    syncStore.setCurrentUserId(userId)
    const unsubscribe = eventsGateway.subscribeServerEvents((event) => {
      syncStore.handleGatewayEvent(event)

      if (event.type === 'ChannelGroupLeave' && event.user === userId) {
        syncStore.removeChannel(event.id)
      }
      if (event.type === 'Ready' && event.voice_states) {
        ensureVoiceUsersLoaded(
          event.voice_states.flatMap((entry) => entry.participants.map((p) => p.id)),
          token,
        )
        syncStore.pruneUnknownVoiceParticipants(userId)
      }
      if (event.type === 'VoiceChannelJoin') {
        const state = normalizeUserVoiceState(event.state)
        if (state) ensureVoiceUsersLoaded([state.id], token)
      }
      if (event.type === 'VoiceChannelMove') ensureVoiceUsersLoaded([event.user], token)
      if (event.type === 'VoiceStateUpdate') ensureVoiceUsersLoaded([event.state.id], token)
      if (event.type === 'VoiceChannelLeave') syncStore.pruneUnknownVoiceParticipants(userId)
    })
    eventsGateway.enableAutoReconnect(WS_URL, token)
    eventsGateway.connect(WS_URL, token)
    return () => {
      unsubscribe()
      eventsGateway.disableAutoReconnect()
      eventsGateway.disconnect()
      syncStore.reset()
    }
  }, [token, userId])

  // Unreads and voice users can go stale while disconnected.
  useEffect(() => {
    if (!ready) return
    const fiber = Effect.runFork(refreshSyncAfterReconnect(token, userId))
    const unsubscribe = eventsGateway.subscribeState((state) => {
      const prev = prevStateRef.current
      prevStateRef.current = state
      if (state === 'connected' && (prev === 'disconnected' || prev === 'reconnecting')) {
        Effect.runFork(refreshSyncAfterReconnect(token, userId))
      }
    })
    return () => {
      unsubscribe()
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [ready, token, userId])

  return children
}
