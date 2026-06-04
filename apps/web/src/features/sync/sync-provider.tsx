import { useEffect, type ReactNode } from 'react'

import { fetchUnreads } from '#/features/api/sync-api'
import { useAuth } from '#/features/auth/auth-context'
import { eventsGateway } from '#/features/events/gateway'
import { config } from '#/lib/config'

import { useMessageNotifications } from '#/features/notifications/use-message-notifications'

import { ensureVoiceUsersLoaded } from './ensure-voice-users'
import { syncStore, useSyncReady } from './sync-store'
import type { GatewayServerEvent } from './types'
import { normalizeUserVoiceState } from './voice-event-utils'
import type { ChannelVoiceState } from './voice-types'

export function SyncProvider({ children }: { children: ReactNode }) {
  useMessageNotifications()
  const auth = useAuth()
  const ready = useSyncReady()

  useEffect(() => {
    const token = auth.session?.token
    const currentUserId = auth.user?._id

    return eventsGateway.subscribeEvents((event) => {
      syncStore.handleGatewayEvent(event as GatewayServerEvent)

      if (!token) return

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

      if (event.type === 'UserVoiceStateUpdate') {
        const update = event as { id: string }
        ensureVoiceUsersLoaded([update.id], token)
      }

      if (event.type === 'VoiceChannelLeave') {
        syncStore.pruneUnknownVoiceParticipants(currentUserId)
      }
    })
  }, [auth.session?.token, auth.user?._id])

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
    const token = auth.session?.token
    if (!token || !ready) return

    void fetchUnreads(token)
      .then((unreads) => syncStore.setUnreads(unreads))
      .catch(() => {
        // unreads optional if endpoint fails
      })
  }, [auth.session?.token, ready])

  return children
}
