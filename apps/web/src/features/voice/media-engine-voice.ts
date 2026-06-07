import type {
  MediaEngineEvent,
  MediaEngineMicProcessingParams,
  MediaEngineNoiseSuppressionMode,
  MediaEngineRoomConnectParams,
} from '@syrnike13/platform'

import {
  toEngineMicProcessingParams,
} from '#/features/voice/media-engine-voice-setup'
import { readVoicePreferences } from '#/features/voice/voice-preference-store'
import type { NoiseSuppressionMode } from '#/features/voice/voice-preference-types'

import {
  applyEngineParticipantsSnapshot,
  applyEngineTrackPublished,
  applyEngineTrackUnpublished,
  type EngineParticipantsSnapshot,
  type EngineTrackSource,
} from '#/features/voice/media-engine-participant-sync'
import {
  disposeMediaEngineRemoteAudio,
  playMediaEngineRemoteAudioFrame,
  setMediaEngineRemoteAudioDeafened,
  stopMediaEngineRemoteAudio,
} from '#/features/voice/media-engine-remote-audio'
import {
  clearMediaEngineRemoteVideo,
  disposeMediaEngineRemoteVideo,
  updateMediaEngineRemoteVideoFrame,
} from '#/features/voice/media-engine-remote-video'
import { getSyrnikeDesktop } from '#/platform/runtime'

export type MediaEngineVoiceSession = {
  localUserId: string
  disconnect: () => Promise<void>
  setMicEnabled: (enabled: boolean) => Promise<void>
  setNoiseSuppression: (mode: NoiseSuppressionMode) => Promise<void>
  setMicDevice: (deviceId?: string) => Promise<void>
  setMicProcessing: (params: MediaEngineMicProcessingParams) => Promise<void>
  getRttMs: () => Promise<number | null>
  setDeafened: (deafened: boolean) => void
  setCameraDevice: (deviceId?: string) => Promise<void>
  setCameraEnabled: (enabled: boolean) => Promise<void>
}

function toEngineNoiseSuppressionMode(
  mode: NoiseSuppressionMode,
): MediaEngineNoiseSuppressionMode {
  return mode
}

export type MediaEngineVoiceContext = {
  channelId: string
  localMicPublishing: boolean
  localReceiving: boolean
}

export type MediaEngineVoiceHandlers = {
  onStateChange?: () => void
  onDisconnected?: () => void
  onActiveSpeakers?: (userIds: ReadonlySet<string>) => void
  getContext?: () => MediaEngineVoiceContext | null
}

function isEngineTrackSource(value: unknown): value is EngineTrackSource {
  return value === 'screen' || value === 'camera'
}

function parseParticipantsSnapshot(
  params: unknown,
): EngineParticipantsSnapshot | null {
  if (!params || typeof params !== 'object') return null
  const snapshot = params as EngineParticipantsSnapshot
  if (typeof snapshot.localUserId !== 'string') return null
  if (!Array.isArray(snapshot.participants)) return null
  return snapshot
}

function parseActiveSpeakerIds(params: unknown): string[] | null {
  if (!params || typeof params !== 'object') return null
  const userIds = (params as { userIds?: unknown }).userIds
  if (!Array.isArray(userIds)) return null
  return userIds.filter((value): value is string => typeof value === 'string')
}

export async function connectMediaEngineVoice(
  credentials: MediaEngineRoomConnectParams,
  initialMicEnabled: boolean,
  handlers: MediaEngineVoiceHandlers = {},
): Promise<MediaEngineVoiceSession> {
  const desktop = getSyrnikeDesktop()
  if (!desktop) {
    throw new Error('Desktop bridge is not available')
  }

  const result = await desktop.mediaEngine.roomConnect(credentials)
  let localUserId = ''

  const handleEngineEvent = (event: MediaEngineEvent) => {
    const context = handlers.getContext?.()

    switch (event.event) {
      case 'room.connected':
        localUserId =
          typeof event.params.localUserId === 'string'
            ? event.params.localUserId
            : localUserId
        handlers.onStateChange?.()
        break
      case 'room.participants': {
        if (!context) break
        const snapshot = parseParticipantsSnapshot(event.params)
        if (!snapshot) break
        applyEngineParticipantsSnapshot(context.channelId, snapshot, {
          localMicPublishing: context.localMicPublishing,
          localReceiving: context.localReceiving,
        })
        handlers.onStateChange?.()
        break
      }
      case 'room.activeSpeakers': {
        const userIds = parseActiveSpeakerIds(event.params)
        if (!userIds) break
        handlers.onActiveSpeakers?.(new Set(userIds))
        break
      }
      case 'track.published': {
        if (!context) break
        const userId = event.params.userId
        const source = event.params.source
        if (typeof userId !== 'string' || !isEngineTrackSource(source)) break
        applyEngineTrackPublished(context.channelId, userId, source)
        handlers.onStateChange?.()
        break
      }
      case 'track.unpublished': {
        if (!context) break
        const userId = event.params.userId
        const source = event.params.source
        if (typeof userId !== 'string' || !isEngineTrackSource(source)) break
        applyEngineTrackUnpublished(context.channelId, userId, source)
        handlers.onStateChange?.()
        break
      }
      case 'room.disconnected':
        handlers.onDisconnected?.()
        break
      case 'remote.audio.frame': {
        const userId = event.params.userId
        const pcmBase64 = event.params.pcmBase64
        const sampleRate = event.params.sampleRate
        const channels = event.params.channels
        const samplesPerChannel = event.params.samplesPerChannel
        if (
          typeof userId !== 'string' ||
          typeof pcmBase64 !== 'string' ||
          typeof sampleRate !== 'number' ||
          typeof channels !== 'number' ||
          typeof samplesPerChannel !== 'number'
        ) {
          return
        }
        playMediaEngineRemoteAudioFrame(
          userId,
          pcmBase64,
          sampleRate,
          channels,
          samplesPerChannel,
        )
        break
      }
      case 'remote.audio.ended':
        if (typeof event.params.userId === 'string') {
          stopMediaEngineRemoteAudio(event.params.userId)
        }
        break
      case 'remote.video.frame': {
        const userId = event.params.userId
        const source = event.params.source
        const jpegBase64 = event.params.jpegBase64
        const width = event.params.width
        const height = event.params.height
        if (
          typeof userId !== 'string' ||
          !isEngineTrackSource(source) ||
          typeof jpegBase64 !== 'string' ||
          typeof width !== 'number' ||
          typeof height !== 'number'
        ) {
          return
        }
        updateMediaEngineRemoteVideoFrame(
          userId,
          source,
          jpegBase64,
          width,
          height,
        )
        break
      }
      case 'remote.video.ended': {
        const userId = event.params.userId
        const source = event.params.source
        if (typeof userId === 'string' && isEngineTrackSource(source)) {
          clearMediaEngineRemoteVideo(userId, source)
          handlers.onStateChange?.()
        }
        break
      }
      case 'local.preview.frame': {
        const source = event.params.source
        const jpegBase64 = event.params.jpegBase64
        const width = event.params.width
        const height = event.params.height
        if (
          !localUserId ||
          !isEngineTrackSource(source) ||
          typeof jpegBase64 !== 'string' ||
          typeof width !== 'number' ||
          typeof height !== 'number'
        ) {
          return
        }
        updateMediaEngineRemoteVideoFrame(
          localUserId,
          source,
          jpegBase64,
          width,
          height,
        )
        handlers.onStateChange?.()
        break
      }
      case 'local.preview.ended': {
        const source = event.params.source
        if (!localUserId || !isEngineTrackSource(source)) return
        clearMediaEngineRemoteVideo(localUserId, source)
        handlers.onStateChange?.()
        break
      }
      default:
        break
    }
  }

  const unsubscribe = desktop.mediaEngine.onEvent(handleEngineEvent)

  const initialPrefs = readVoicePreferences()
  const initialProcessing = toEngineMicProcessingParams(initialPrefs)

  await desktop.mediaEngine.micSetProcessing(initialProcessing)
  if (initialPrefs.preferredAudioInputDevice) {
    await desktop.mediaEngine.micSetDevice({
      deviceId: initialPrefs.preferredAudioInputDevice,
    })
  }
  if (initialPrefs.preferredVideoDevice) {
    await desktop.mediaEngine.cameraSetDevice({
      deviceId: initialPrefs.preferredVideoDevice,
    })
  }

  await desktop.mediaEngine.micSetEnabled({
    enabled: initialMicEnabled,
    noiseSuppression: toEngineNoiseSuppressionMode(initialPrefs.noiseSuppression),
  })

  return {
    localUserId: localUserId || result.sid,
    async setMicEnabled(enabled: boolean) {
      const prefs = readVoicePreferences()
      await desktop.mediaEngine.micSetEnabled({
        enabled,
        noiseSuppression: toEngineNoiseSuppressionMode(prefs.noiseSuppression),
      })
    },
    async setNoiseSuppression(mode: NoiseSuppressionMode) {
      await desktop.mediaEngine.micSetNoiseSuppression(
        toEngineNoiseSuppressionMode(mode),
      )
    },
    async setMicDevice(deviceId?: string) {
      await desktop.mediaEngine.micSetDevice({ deviceId })
    },
    async setMicProcessing(params: MediaEngineMicProcessingParams) {
      await desktop.mediaEngine.micSetProcessing(params)
    },
    async getRttMs() {
      const result = await desktop.mediaEngine.roomGetRtt()
      return result.rttMs
    },
    async setCameraDevice(deviceId?: string) {
      await desktop.mediaEngine.cameraSetDevice({ deviceId })
    },
    async setCameraEnabled(enabled: boolean) {
      await desktop.mediaEngine.cameraSetEnabled(enabled)
    },
    setDeafened(value: boolean) {
      setMediaEngineRemoteAudioDeafened(value)
    },
    async disconnect() {
      unsubscribe()
      disposeMediaEngineRemoteAudio()
      disposeMediaEngineRemoteVideo()
      await desktop.mediaEngine.roomDisconnect()
    },
  }
}
