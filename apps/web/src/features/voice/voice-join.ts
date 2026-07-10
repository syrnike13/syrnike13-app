import { Room } from 'livekit-client'
import { toast } from 'sonner'
import type { Channel } from '@syrnike13/api-types'

import { syncStore } from '#/features/sync/sync-store'
import { canJoinVoiceChannel } from '#/features/voice/voice-api-capability'
import { createVoiceRoomOptions } from '#/features/voice/voice-capture'
import { createConnectingLocalVoiceState } from '#/features/voice/voice-connecting-preview'
import {
  isVoiceRequestAborted,
  requestVoiceJoin,
  type VoiceServerUpdateEvent,
} from '#/features/voice/voice-gateway'
import { readVoicePreferences } from '#/features/voice/voice-preference-store'
import type { VoiceConnectionPhase } from '#/features/voice/voice-mic-status'

export type VoiceJoinOptions = {
  operationId: string
  rejoin?: boolean
  expectedCurrentOperationId?: string
  reuseExistingRoom?: boolean
  onGatewayDispatched?: () => void
  onGatewayAccepted?: () => void
  onGatewayRejected?: (authoritativeOperationId: string | null) => void
  signal?: AbortSignal
}

export type VoiceJoinSuccess = {
  room: Room
}

export type VoiceJoinResult = boolean | VoiceJoinSuccess

export type LiveKitNativeMediaKind = 'microphone' | 'screen' | 'camera'
export type LiveKitNativePublisherCredentials = {
  url: string
  token: string
  participantIdentity: string
}
export type LiveKitNativeCredentials = Record<
  LiveKitNativeMediaKind,
  LiveKitNativePublisherCredentials
>

export type LiveKitNativeCredentialLease = Readonly<{
  operationId: string
  channelId: string
  credentials: LiveKitNativeCredentials
}>

export type ActiveVoiceSessionSnapshot = {
  room: Room
  channelId: string
  localVoiceReady: boolean
}

export function nativeCredentialLeaseFromJoinResponse(
  credentials: VoiceServerUpdateEvent,
): LiveKitNativeCredentialLease {
  return {
    operationId: credentials.operation_id,
    channelId: credentials.channel_id,
    credentials: {
      microphone: {
        url: credentials.url,
        token: credentials.native_microphone.token,
        participantIdentity: credentials.native_microphone.identity,
      },
      screen: {
        url: credentials.url,
        token: credentials.native_screen.token,
        participantIdentity: credentials.native_screen.identity,
      },
      camera: {
        url: credentials.url,
        token: credentials.native_camera.token,
        participantIdentity: credentials.native_camera.identity,
      },
    },
  }
}

export type VoiceJoinRunnerDeps = {
  getToken: () => string | undefined
  getLocalUserId: () => string | undefined
  isJoinBlocked: () => boolean
  isCurrentJoinOperation?: (operationId: string) => boolean
  beginConnecting: (
    channelId: string,
    preview: ReturnType<typeof createConnectingLocalVoiceState>[],
  ) => void
  attachRoomHandlers: (room: Room) => void
  setLiveKitCredentials: (lease: LiveKitNativeCredentialLease) => void
  setConnectionPhase: (phase: VoiceConnectionPhase) => void
  onJoinSuccess: () => void
  abortJoin: () => void
}

export type VoiceJoinRunnerOptions = {
  getDeps: () => VoiceJoinRunnerDeps
}

export function voiceJoinErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return 'Не удалось подключиться к голосу'
}

const supersededJoin = Symbol('superseded-voice-join')

function waitWhileCurrent<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise as Promise<T | typeof supersededJoin>
  if (signal.aborted) {
    return Promise.resolve(supersededJoin)
  }

  return new Promise<T | typeof supersededJoin>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      resolve(supersededJoin)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function observeGatewayAuthority(
  promise: Promise<VoiceServerUpdateEvent>,
  options: VoiceJoinOptions,
) {
  return promise.then(
    (credentials) => {
      options.onGatewayAccepted?.()
      return credentials
    },
    (error: unknown) => {
      if (
        error instanceof Error &&
        'authoritativeOperationId' in error &&
        (typeof error.authoritativeOperationId === 'string' ||
          error.authoritativeOperationId === null)
      ) {
        options.onGatewayRejected?.(error.authoritativeOperationId)
      }
      throw error
    },
  )
}

function voiceCallRecipients(
  channel: Channel | undefined,
  localUserId: string | undefined,
) {
  if (!channel || !localUserId) return undefined
  if (
    channel.channel_type !== 'DirectMessage' &&
    channel.channel_type !== 'Group'
  ) {
    return undefined
  }

  const recipients = channel.recipients.filter(
    (userId) => userId !== localUserId,
  )
  return recipients.length > 0 ? recipients : undefined
}

export function createVoiceJoinRunner({ getDeps }: VoiceJoinRunnerOptions) {
  return async function performVoiceJoin(
    targetChannelId: string,
    options: VoiceJoinOptions,
  ): Promise<VoiceJoinResult> {
    const deps = getDeps()
    const token = deps.getToken()
    if (!token) {
      if (!options.rejoin) toast.error('Нет сессии')
      return false
    }

    if (deps.isJoinBlocked()) {
      return false
    }

    const targetChannel = syncStore.getState().channels[targetChannelId]
    if (!canJoinVoiceChannel(targetChannel)) {
      if (!options.rejoin) {
        toast.error('Голос недоступен в этом канале')
      }
      return false
    }

    const prefs = readVoicePreferences()
    const localUserId = deps.getLocalUserId()
    const operationId = options.operationId
    const preview = localUserId
      ? [
          createConnectingLocalVoiceState(localUserId, {
            micEnabled: prefs.micEnabled,
            deafened: prefs.deafened,
          }),
        ]
      : []

    deps.setConnectionPhase('joining_channel')
    deps.beginConnecting(targetChannelId, preview)

    let room: Room | null = null

    try {
      deps.setConnectionPhase('fetching_rtc_token')
      const callRecipients = options.rejoin
        ? undefined
        : voiceCallRecipients(targetChannel, localUserId)
      const gatewayOptions = {
        operationId,
        ...(options.expectedCurrentOperationId
          ? { expectedCurrentOperationId: options.expectedCurrentOperationId }
          : {}),
        ...(options.onGatewayDispatched
          ? { onDispatched: options.onGatewayDispatched }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.reuseExistingRoom ? { retainFinalized: true } : {}),
      }
      const gatewayResponse = callRecipients
        ? requestVoiceJoin(
            targetChannelId,
            !prefs.micEnabled,
            prefs.deafened,
            { ...gatewayOptions, recipients: callRecipients },
          )
        : requestVoiceJoin(
            targetChannelId,
            !prefs.micEnabled,
            prefs.deafened,
            options.rejoin
              ? { ...gatewayOptions, suppress_call_notifications: true }
              : gatewayOptions,
          )
      const credentials = await waitWhileCurrent(
        observeGatewayAuthority(gatewayResponse, options),
        options.signal,
      )
      if (credentials === supersededJoin) {
        return false
      }
      if (getDeps().isCurrentJoinOperation?.(operationId) === false) {
        return false
      }

      const { url, token: livekitToken } = credentials
      getDeps().setLiveKitCredentials(
        nativeCredentialLeaseFromJoinResponse(credentials),
      )
      if (options.reuseExistingRoom) {
        getDeps().setConnectionPhase('connecting_microphone')
        getDeps().onJoinSuccess()
        return true
      }

      room = new Room(createVoiceRoomOptions())
      getDeps().attachRoomHandlers(room)

      getDeps().setConnectionPhase('connecting_rtc')
      const connected = await waitWhileCurrent(
        room.connect(url, livekitToken),
        options.signal,
      )
      if (connected === supersededJoin) {
        room.removeAllListeners()
        void room.disconnect().catch(() => {})
        return false
      }
      if (getDeps().isCurrentJoinOperation?.(operationId) === false) {
        room.removeAllListeners()
        await room.disconnect().catch(() => {})
        return false
      }

      getDeps().setConnectionPhase('connecting_microphone')
      getDeps().onJoinSuccess()
      return { room }
    } catch (error) {
      if (getDeps().isCurrentJoinOperation?.(operationId) === false) {
        return false
      }
      if (isVoiceRequestAborted(error)) {
        if (room) {
          room.removeAllListeners()
          await room.disconnect().catch(() => {})
        }
        return false
      }
      getDeps().setConnectionPhase('failed')
      // Очистка transient-комнаты обязательна в обоих режимах: даже при
      // rejoin после `new Room()` + attachRoomHandlers могла повиснуть комната
      // с обработчиками, которую никто не получил. Не чистим только если комната
      // так и не была создана.
      if (room) {
        room.removeAllListeners()
        await room.disconnect().catch(() => {})
      }
      if (!options.rejoin) {
        getDeps().abortJoin()
        toast.error(voiceJoinErrorMessage(error))
      }
      return false
    }
  }
}

export type VoiceJoinRunner = ReturnType<typeof createVoiceJoinRunner>
