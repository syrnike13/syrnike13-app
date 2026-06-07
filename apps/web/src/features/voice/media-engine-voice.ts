import type { MediaEngineRoomConnectParams } from '@syrnike13/platform'

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
  setCameraEnabled: (enabled: boolean) => Promise<void>
  setDeafened: (deafened: boolean) => void
}

export async function connectMediaEngineVoice(
  credentials: MediaEngineRoomConnectParams,
  initialMicEnabled: boolean,
): Promise<MediaEngineVoiceSession> {
  const desktop = getSyrnikeDesktop()
  if (!desktop) {
    throw new Error('Desktop bridge is not available')
  }

  const result = await desktop.mediaEngine.roomConnect(credentials)
  let localUserId = ''

  const unsubscribe = desktop.mediaEngine.onEvent((event) => {
    switch (event.event) {
      case 'room.connected':
        localUserId =
          typeof event.params.localUserId === 'string'
            ? event.params.localUserId
            : localUserId
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
          (source !== 'screen' && source !== 'camera') ||
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
        if (
          typeof userId === 'string' &&
          (source === 'screen' || source === 'camera')
        ) {
          clearMediaEngineRemoteVideo(userId, source)
        }
        break
      }
      default:
        break
    }
  })

  await desktop.mediaEngine.micSetEnabled(initialMicEnabled)

  return {
    localUserId: localUserId || result.sid,
    async setMicEnabled(enabled: boolean) {
      await desktop.mediaEngine.micSetEnabled(enabled)
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
