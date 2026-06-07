import { Room } from 'livekit-client'
import { toast } from 'sonner'

import { joinChannelCall } from '#/features/api/voice-api'
import { syncStore } from '#/features/sync/sync-store'
import {
  canUseVoiceRestApi,
  handleVoiceApiError,
} from '#/features/voice/voice-api-capability'
import { createVoiceRoomOptions } from '#/features/voice/voice-capture'
import { createConnectingLocalVoiceState } from '#/features/voice/voice-connecting-preview'
import { readVoicePreferences } from '#/features/voice/voice-preference-store'
import {
  isRateLimitedError,
  runVoiceRequest,
} from '#/features/voice/voice-request-gate'
import { ApiError } from '#/lib/api/client'

export type VoiceJoinOptions = {
  rejoin?: boolean
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
  onRoomConnected: (room: Room, channelId: string) => void
  onLivekitCredentials?: (credentials: { url: string; token: string }) => void
  onJoinSuccess: () => void
  abortJoin: () => void
}

export function voiceJoinErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 429) {
    return 'Слишком много запросов. Подождите минуту и попробуйте снова.'
  }
  if (error instanceof ApiError && error.status === 400) {
    return 'Голос недоступен в этом канале'
  }
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
    if (!canUseVoiceRestApi(targetChannel)) {
      if (!options.rejoin) {
        toast.error('Голос недоступен в этом канале')
      }
      return false
    }

    if (!options.rejoin && deps.shouldLeaveBeforeJoin()) {
      await deps.leaveBeforeJoin()
    }

    const localUserId = deps.getLocalUserId()
    const preview = localUserId
      ? [
          createConnectingLocalVoiceState(localUserId, {
            micEnabled: readVoicePreferences().micEnabled,
            deafened: readVoicePreferences().deafened,
          }),
        ]
      : []

    deps.beginConnecting(targetChannelId, preview)

    try {
      const credentials = await runVoiceRequest(
        `join_call:${targetChannelId}`,
        () => joinChannelCall(token, targetChannelId),
        10_000,
      )
      if (!credentials) {
        if (!options.rejoin) deps.abortJoin()
        return false
      }

      const { url, token: livekitToken } = credentials
      deps.onLivekitCredentials?.({ url, token: livekitToken })
      const room = new Room(createVoiceRoomOptions())
      deps.setActiveRoom(room)
      deps.attachRoomHandlers(room)

      await room.connect(url, livekitToken)

      deps.onRoomConnected(room, targetChannelId)
      deps.onJoinSuccess()
      return true
    } catch (error) {
      if (!options.rejoin) {
        deps.abortJoin()
        handleVoiceApiError(targetChannelId, error)
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
