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
  isRateLimitedError,
  runVoiceRequest,
} from '#/features/voice/voice-request-gate'
import type { VoiceConnectionPhase } from '#/features/voice/voice-mic-status'
import type { VoiceJoinReason } from '#/features/voice/voice-session-machine'

export const VOICE_JOIN_RETRY_COOLDOWN_MS = 500
const VOICE_JOIN_RATE_LIMIT_COOLDOWN_MS = 60_000

export type VoiceJoinOptions = {
  rejoin?: boolean
}

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
  setJoinBlockedUntil: (timestamp: number) => void
  getActiveSession: () => ActiveVoiceSessionSnapshot | null
  requestJoinOperation: (
    channelId: string,
    reason: VoiceJoinReason,
  ) => string
  handleServerPrepareSucceeded: (operationId: string) => void
  handleRoomConnected: (operationId: string) => void
  handleRoomConnectFailed: (operationId: string, error: string) => void
  beginConnecting: (
    channelId: string,
    preview: ReturnType<typeof createConnectingLocalVoiceState>[],
  ) => void
  setActiveRoom: (room: Room) => void
  disconnectReplacedRoom: (room: Room) => Promise<void>
  restorePreviousSession: (
    session: ActiveVoiceSessionSnapshot,
    failedTargetChannelId: string,
  ) => void
  attachRoomHandlers: (room: Room) => void
  setLiveKitCredentials: (credentials: LiveKitNativeCredentials) => void
  setConnectionPhase: (phase: VoiceConnectionPhase) => void
  onRoomConnected: (room: Room, channelId: string) => void
  onJoinSuccess: () => void
  abortJoin: () => void
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

function voiceJoinReason(
  channel: Channel | undefined,
  options: VoiceJoinOptions,
  previousSession: ActiveVoiceSessionSnapshot | null,
): VoiceJoinReason {
  if (options.rejoin) return 'rejoin'
  if (previousSession) return 'switch'
  if (
    channel?.channel_type === 'DirectMessage' ||
    channel?.channel_type === 'Group'
  ) {
    return 'dm_answer'
  }
  return 'manual_join'
}

export function createVoiceJoinRunner(deps: VoiceJoinRunnerDeps) {
  return async function performVoiceJoin(
    targetChannelId: string,
    options: VoiceJoinOptions = {},
  ): Promise<boolean> {
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
    const previousSession = options.rejoin ? null : deps.getActiveSession()
    const operationId = deps.requestJoinOperation(
      targetChannelId,
      voiceJoinReason(targetChannel, options, previousSession),
    )
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
        if (previousSession) {
          deps.restorePreviousSession(previousSession, targetChannelId)
        } else if (!options.rejoin) {
          deps.abortJoin()
        }
        return false
      }
      deps.handleServerPrepareSucceeded(operationId)

      const { url, token: livekitToken } = credentials
      room = new Room(createVoiceRoomOptions())
      deps.setLiveKitCredentials(nativeCredentialsFromJoinResponse(credentials))
      deps.attachRoomHandlers(room)

      deps.setConnectionPhase('connecting_rtc')
      await room.connect(url, livekitToken)
      deps.handleRoomConnected(operationId)
      deps.setActiveRoom(room)
      if (previousSession && previousSession.room !== room) {
        await deps.disconnectReplacedRoom(previousSession.room)
      }

      deps.setConnectionPhase('connecting_microphone')
      deps.onRoomConnected(room, targetChannelId)
      deps.onJoinSuccess()
      return true
    } catch (error) {
      deps.setConnectionPhase('failed')
      deps.handleRoomConnectFailed(operationId, voiceJoinErrorMessage(error))
      if (!options.rejoin) {
        if (room) {
          room.removeAllListeners()
          await room.disconnect().catch(() => {})
        }
        if (previousSession) {
          deps.restorePreviousSession(previousSession, targetChannelId)
        } else {
          deps.abortJoin()
        }
        toast.error(voiceJoinErrorMessage(error))
      }
      deps.setJoinBlockedUntil(
        Date.now() +
          (isRateLimitedError(error)
            ? VOICE_JOIN_RATE_LIMIT_COOLDOWN_MS
            : VOICE_JOIN_RETRY_COOLDOWN_MS),
      )
      return false
    }
  }
}

export type VoiceJoinRunner = ReturnType<typeof createVoiceJoinRunner>
