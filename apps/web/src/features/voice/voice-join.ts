import { Room } from 'livekit-client'
import { toast } from 'sonner'

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
  shouldLeaveBeforeJoin: () => boolean
  leaveBeforeJoin: () => Promise<void>
  beginConnecting: (
    channelId: string,
    preview: ReturnType<typeof createConnectingLocalVoiceState>[],
  ) => void
  setActiveRoom: (room: Room) => void
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

    if (!options.rejoin && deps.shouldLeaveBeforeJoin()) {
      await deps.leaveBeforeJoin()
    }

    const prefs = readVoicePreferences()
    const localUserId = deps.getLocalUserId()
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

    try {
      deps.setConnectionPhase('fetching_rtc_token')
      // #region debug log
      fetch('http://127.0.0.1:65045/ingest/eef881',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'eef881',runId:'voice-switch-a-to-b',hypothesisId:'C,D',location:'apps/web/src/features/voice/voice-join.ts:requestVoiceJoin:start',message:'request voice join start',data:{targetChannelId,rejoin:options.rejoin===true},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      const credentials = await runVoiceRequest(
        `voice_join:${targetChannelId}`,
        () =>
          requestVoiceJoin(
            targetChannelId,
            !prefs.micEnabled,
            prefs.deafened,
          ),
        0,
      )
      if (!credentials) {
        // #region debug log
        fetch('http://127.0.0.1:65045/ingest/eef881',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'eef881',runId:'voice-switch-a-to-b',hypothesisId:'B,C',location:'apps/web/src/features/voice/voice-join.ts:requestVoiceJoin:empty',message:'request voice join returned empty',data:{targetChannelId,rejoin:options.rejoin===true},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        if (!options.rejoin) deps.abortJoin()
        return false
      }

      const { url, token: livekitToken } = credentials
      const room = new Room(createVoiceRoomOptions())
      deps.setLiveKitCredentials(nativeCredentialsFromJoinResponse(credentials))
      deps.setActiveRoom(room)
      deps.attachRoomHandlers(room)

      deps.setConnectionPhase('connecting_rtc')
      await room.connect(url, livekitToken)

      deps.setConnectionPhase('connecting_microphone')
      deps.onRoomConnected(room, targetChannelId)
      deps.onJoinSuccess()
      return true
    } catch (error) {
      deps.setConnectionPhase('failed')
      // #region debug log
      fetch('http://127.0.0.1:65045/ingest/eef881',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'eef881',runId:'voice-switch-a-to-b',hypothesisId:'C,D',location:'apps/web/src/features/voice/voice-join.ts:catch',message:'voice join failed',data:{targetChannelId,rejoin:options.rejoin===true,errorName:error instanceof Error?error.name:typeof error,errorMessage:error instanceof Error?error.message:'non-error'},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      if (!options.rejoin) {
        deps.abortJoin()
        toast.error(voiceJoinErrorMessage(error))
      }
      deps.setJoinBlockedUntil(
        Date.now() + (isRateLimitedError(error) ? 60_000 : 15_000),
      )
      return false
    }
  }
}

export type VoiceJoinRunner = ReturnType<typeof createVoiceJoinRunner>
