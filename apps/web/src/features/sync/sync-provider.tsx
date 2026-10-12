import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { User } from '@syrnike13/api-types'
import { Effect, Fiber } from 'effect'
import { useEffect, useRef, type ReactNode } from 'react'

import { useAuth } from '#/features/auth/auth-context'
import { eventsGateway } from '#/features/events/gateway'
import { config } from '#/lib/config'
import { queryKeys } from '#/lib/api/query-keys'

import { useMessageNotifications } from '#/features/notifications/use-message-notifications'
import { closeVoiceCallNotification } from '#/features/notifications/voice-call-notifications'
import { useEventSounds } from '#/features/sounds/use-event-sounds'

import { ensureVoiceUsersLoaded } from './ensure-voice-users'
import { refreshSyncAfterReconnect } from './refresh-sync-after-reconnect'
import { syncStore, useSyncReady } from './sync-store'
import { normalizeUserVoiceState } from './voice-event-utils'

function patchAuthSessionOnline(
  queryClient: QueryClient,
  currentUserId: string | undefined,
  online: boolean,
) {
  if (!currentUserId) return
  queryClient.setQueryData<User | undefined>(
    queryKeys.auth.session,
    (prev) => {
      if (!prev || prev._id !== currentUserId) return prev
      if (prev.online === online) return prev
      return { ...prev, online }
    },
  )
}

function syncAuthSessionOnlineFromStore(
  queryClient: QueryClient,
  currentUserId: string | undefined,
) {
  if (!currentUserId) return
  const syncUser = syncStore.getState().users[currentUserId]
  if (!syncUser) return
  patchAuthSessionOnline(queryClient, currentUserId, syncUser.online)
}

export function SyncProvider({ children }: { children: ReactNode }) {
  useMessageNotifications()
  const auth = useAuth()
  const ready = useSyncReady()
  const queryClient = useQueryClient()
  const prevGatewayStateRef = useRef(eventsGateway.state)

  useEffect(() => {
    syncStore.setCurrentUserId(auth.user?._id)
  }, [auth.user?._id])

  useEffect(() => {
    const token = auth.session?.token
    const currentUserId = auth.user?._id

    const unsubscribe = eventsGateway.subscribeServerEvents((gatewayEvent) => {
      syncStore.handleGatewayEvent(gatewayEvent)

      if (currentUserId) {
        if (gatewayEvent.type === 'Ready') {
          syncAuthSessionOnlineFromStore(queryClient, currentUserId)
        }
        if (gatewayEvent.type === 'ChannelGroupLeave') {
          if (gatewayEvent.user === currentUserId) {
            syncStore.removeChannel(gatewayEvent.id)
          }
        }
        if (gatewayEvent.type === 'UserUpdate') {
          if (
            gatewayEvent.id === currentUserId &&
            gatewayEvent.data.online !== undefined
          ) {
            patchAuthSessionOnline(
              queryClient,
              currentUserId,
              gatewayEvent.data.online,
            )
          }
        }
        if (gatewayEvent.type === 'UserPresence') {
          if (gatewayEvent.id === currentUserId) {
            patchAuthSessionOnline(
              queryClient,
              currentUserId,
              gatewayEvent.online,
            )
          }
        }
      }

      if (!token) return

      if (gatewayEvent.type === 'ChannelGroupJoin') {
        ensureVoiceUsersLoaded([gatewayEvent.user], token)
      }

      if (gatewayEvent.type === 'VoiceCallRinging') {
        ensureVoiceUsersLoaded(
          [
            gatewayEvent.initiator_id,
            ...gatewayEvent.recipients,
            ...gatewayEvent.declined_recipients,
          ],
          token,
        )
      }

      if (gatewayEvent.type === 'VoiceCallActive') {
        ensureVoiceUsersLoaded(
          [
            gatewayEvent.initiator_id,
            ...gatewayEvent.declined_recipients,
          ],
          token,
        )
        Effect.runFork(closeVoiceCallNotification(gatewayEvent.channel_id))
      }

      if (gatewayEvent.type === 'VoiceCallEnd') {
        Effect.runFork(closeVoiceCallNotification(gatewayEvent.channel_id))
      }

      if (gatewayEvent.type === 'Ready' && gatewayEvent.voice_calls) {
        const userIds = gatewayEvent.voice_calls.flatMap((call) => [
          call.initiator_id,
          ...call.recipients,
          ...call.declined_recipients,
        ])
        ensureVoiceUsersLoaded(userIds, token)
      }

      if (gatewayEvent.type === 'Ready' && gatewayEvent.voice_states) {
        const userIds = gatewayEvent.voice_states.flatMap((entry) =>
          entry.participants.map((participant) => participant.id),
        )
        ensureVoiceUsersLoaded(userIds, token)
        syncStore.pruneUnknownVoiceParticipants(currentUserId)
      }

      if (gatewayEvent.type === 'VoiceChannelJoin') {
        const voiceState = normalizeUserVoiceState(gatewayEvent.state)
        if (voiceState) {
          ensureVoiceUsersLoaded([voiceState.id], token)
        }
      }

      if (gatewayEvent.type === 'VoiceChannelMove') {
        ensureVoiceUsersLoaded([gatewayEvent.user], token)
      }

      if (gatewayEvent.type === 'VoiceStateUpdate') {
        ensureVoiceUsersLoaded([gatewayEvent.state.id], token)
      }

      if (gatewayEvent.type === 'VoiceChannelLeave') {
        syncStore.pruneUnknownVoiceParticipants(currentUserId)
      }
    })

    return () => {
      unsubscribe()
    }
  }, [auth.session?.token, auth.user?._id, queryClient])

  /** Ready мог прийти до монтирования подписчика — переподключаем WS. */
  useEffect(() => {
    if (!auth.hydrated || !auth.session?.token) return
    if (syncStore.getState().ready) return
    if (eventsGateway.state !== 'connected') return

    eventsGateway.connect(config.wsUrl, auth.session.token)
  }, [auth.hydrated, auth.session?.token])

  useEffect(() => {
    if (!ready) return
    syncStore.pruneUnknownVoiceParticipants(auth.user?._id)
  }, [auth.user?._id, ready])

  useEffect(() => {
    if (!ready) return
    syncAuthSessionOnlineFromStore(queryClient, auth.user?._id)
  }, [auth.user?._id, queryClient, ready])

  useEffect(() => {
    const token = auth.session?.token
    if (!token || !ready) return

    const fiber = Effect.runFork(
      refreshSyncAfterReconnect(token, auth.user?._id),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [auth.session?.token, auth.user?._id, ready])

  useEffect(() => {
    const token = auth.session?.token
    const currentUserId = auth.user?._id
    let refreshFiber: ReturnType<typeof Effect.runFork> | undefined

    const unsubscribe = eventsGateway.subscribeState((state) => {
      const prev = prevGatewayStateRef.current
      prevGatewayStateRef.current = state

      if (
        state !== 'connected' ||
        (prev !== 'disconnected' && prev !== 'reconnecting') ||
        !ready ||
        !token
      ) {
        return
      }

      if (refreshFiber) Effect.runFork(Fiber.interrupt(refreshFiber))
      refreshFiber = Effect.runFork(
        refreshSyncAfterReconnect(token, currentUserId),
      )
    })

    return () => {
      unsubscribe()
      if (refreshFiber) Effect.runFork(Fiber.interrupt(refreshFiber))
    }
  }, [auth.session?.token, auth.user?._id, ready])

  useEventSounds()

  return children
}
