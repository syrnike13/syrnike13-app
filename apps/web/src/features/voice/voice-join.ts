import { Room } from 'livekit-client'
import { toast } from 'sonner'
import type { Channel } from '@syrnike13/api-types'

import { syncStore } from '#/features/sync/sync-store'
import { canJoinVoiceChannel } from '#/features/voice/voice-api-capability'
import { createVoiceRoomOptions } from '#/features/voice/voice-capture'
import { createConnectingLocalVoiceState } from '#/features/voice/voice-connecting-preview'
import {
  requestVoiceJoin,
  type VoiceServerUpdateEvent,
} from '#/features/voice/voice-gateway'
import { readVoicePreferences } from '#/features/voice/voice-preference-store'
import {
  runVoiceRequest,
} from '#/features/voice/voice-request-gate'
import type { VoiceConnectionPhase } from '#/features/voice/voice-mic-status'

export type VoiceJoinOptions = {
  operationId: string
  rejoin?: boolean
}

export type VoiceJoinSuccess = {
  room: Room
}

export type VoiceJoinResult = false | VoiceJoinSuccess

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

export type ActiveVoiceSessionSnapshot = {
  room: Room
  channelId: string
  localVoiceReady: boolean
}

export function nativeCredentialsFromJoinResponse(
  credentials: VoiceServerUpdateEvent,
): LiveKitNativeCredentials {
  return {
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
  setLiveKitCredentials: (credentials: LiveKitNativeCredentials) => void
  setConnectionPhase: (phase: VoiceConnectionPhase) => void
  onRoomConnected: (room: Room, channelId: string) => void
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
      const credentials = await runVoiceRequest(
        `voice_join:${targetChannelId}`,
        () => {
          if (callRecipients) {
            return requestVoiceJoin(
              targetChannelId,
              !prefs.micEnabled,
              prefs.deafened,
              { operationId, recipients: callRecipients },
            )
          }

          return requestVoiceJoin(
            targetChannelId,
            !prefs.micEnabled,
            prefs.deafened,
            options.rejoin
              ? { operationId, suppress_call_notifications: true }
              : { operationId },
          )
        },
        0,
      )
      if (!credentials) {
        if (!options.rejoin) {
          getDeps().abortJoin()
        }
        return false
      }
      if (getDeps().isCurrentJoinOperation?.(operationId) === false) {
        return false
      }

      const { url, token: livekitToken } = credentials
      room = new Room(createVoiceRoomOptions())
      getDeps().setLiveKitCredentials(
        nativeCredentialsFromJoinResponse(credentials),
      )
      getDeps().attachRoomHandlers(room)

      getDeps().setConnectionPhase('connecting_rtc')
      await room.connect(url, livekitToken)
      if (getDeps().isCurrentJoinOperation?.(operationId) === false) {
        room.removeAllListeners()
        await room.disconnect().catch(() => {})
        return false
      }

      getDeps().setConnectionPhase('connecting_microphone')
      getDeps().onRoomConnected(room, targetChannelId)
      getDeps().onJoinSuccess()
      return { room }
    } catch (error) {
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
