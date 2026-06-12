import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { User } from '@syrnike13/api-types'
import { useEffect, useRef, type ReactNode } from 'react'

import { useAuth } from '#/features/auth/auth-context'
import { eventsGateway } from '#/features/events/gateway'
import { config } from '#/lib/config'
import { queryKeys } from '#/lib/api/query-keys'

import { useMessageNotifications } from '#/features/notifications/use-message-notifications'
import { closeVoiceCallNotification } from '#/features/notifications/voice-call-notifications'

import { ensureVoiceUsersLoaded } from './ensure-voice-users'
import { refreshSyncAfterReconnect } from './refresh-sync-after-reconnect'
import { syncStore, useSyncReady } from './sync-store'
import type { GatewayServerEvent } from './types'
import { normalizeUserVoiceState } from './voice-event-utils'
import type { ChannelVoiceState } from './voice-types'

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
    const token = auth.session?.token
    const currentUserId = auth.user?._id

    const unsubscribe = eventsGateway.subscribeEvents((event) => {
      syncStore.handleGatewayEvent(event as GatewayServerEvent)

      if (currentUserId) {
        if (event.type === 'Ready') {
          syncAuthSessionOnlineFromStore(queryClient, currentUserId)
        }
        if (event.type === 'ChannelGroupLeave') {
          const leave = event as { id: string; user: string }
          if (leave.user === currentUserId) {
            syncStore.removeChannel(leave.id)
          }
        }
        if (event.type === 'UserUpdate') {
          const update = event as { id: string; data: Partial<User> }
          if (
            update.id === currentUserId &&
            update.data.online !== undefined
          ) {
            patchAuthSessionOnline(
              queryClient,
              currentUserId,
              update.data.online,
            )
          }
        }
        if (event.type === 'UserPresence') {
          const presence = event as { id: string; online: boolean }
          if (presence.id === currentUserId) {
            patchAuthSessionOnline(
              queryClient,
              currentUserId,
              presence.online,
            )
          }
        }
      }

      if (!token) return

      if (event.type === 'ChannelGroupJoin') {
        const join = event as { user: string }
        ensureVoiceUsersLoaded([join.user], token)
      }

      if (event.type === 'VoiceCallRinging') {
        const call = event as {
          initiator_id?: string
          recipients?: string[]
          declined_recipients?: string[]
        }
        ensureVoiceUsersLoaded(
          [
            call.initiator_id,
            ...(call.recipients ?? []),
            ...(call.declined_recipients ?? []),
          ].filter(
            (userId): userId is string => Boolean(userId),
          ),
          token,
        )
      }

      if (event.type === 'VoiceCallActive') {
        const call = event as {
          channel_id?: string
          initiator_id?: string
          declined_recipients?: string[]
        }
        if (call.initiator_id) {
          ensureVoiceUsersLoaded(
            [call.initiator_id, ...(call.declined_recipients ?? [])],
            token,
          )
        }
        if (call.channel_id) {
          void closeVoiceCallNotification(call.channel_id)
        }
      }

      if (event.type === 'VoiceCallEnd') {
        const call = event as { channel_id?: string }
        if (call.channel_id) {
          void closeVoiceCallNotification(call.channel_id)
        }
      }

      if (event.type === 'Ready' && Array.isArray(event.voice_calls)) {
        const voiceCalls = event.voice_calls as Array<{
          initiator_id?: string
          recipients?: string[]
          declined_recipients?: string[]
        }>
        const userIds = voiceCalls.flatMap((call) => [
          call.initiator_id,
          ...(call.recipients ?? []),
          ...(call.declined_recipients ?? []),
        ])
        ensureVoiceUsersLoaded(
          userIds.filter((userId): userId is string => Boolean(userId)),
          token,
        )
      }

      if (event.type === 'Ready' && Array.isArray(event.voice_states)) {
        const voiceStates = event.voice_states as ChannelVoiceState[]
        const userIds = voiceStates.flatMap((entry) =>
          (entry.participants ?? []).flatMap((participant) => {
            if (typeof participant === 'string') return participant
            return participant.id ?? ''
          }),
        )
        ensureVoiceUsersLoaded(userIds.filter(Boolean), token)
        syncStore.pruneUnknownVoiceParticipants(currentUserId)
      }

      if (event.type === 'VoiceChannelJoin') {
        const voiceState = normalizeUserVoiceState(
          ((event as { state?: unknown }).state ?? {}) as Parameters<
            typeof normalizeUserVoiceState
          >[0],
        )
        if (voiceState) {
          ensureVoiceUsersLoaded([voiceState.id], token)
        }
      }

      if (event.type === 'VoiceChannelMove') {
        const move = event as { user: string }
        ensureVoiceUsersLoaded([move.user], token)
      }

      if (event.type === 'VoiceStateUpdate') {
        const userId = (event as GatewayServerEvent).state?.id
        if (userId) ensureVoiceUsersLoaded([userId], token)
      }

      if (event.type === 'VoiceChannelLeave') {
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

    void refreshSyncAfterReconnect(token, auth.user?._id)
  }, [auth.session?.token, auth.user?._id, ready])

  useEffect(() => {
    const token = auth.session?.token
    const currentUserId = auth.user?._id

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

      void refreshSyncAfterReconnect(token, currentUserId)
    })

    return () => {
      unsubscribe()
    }
  }, [auth.session?.token, auth.user?._id, ready])

  return children
}
