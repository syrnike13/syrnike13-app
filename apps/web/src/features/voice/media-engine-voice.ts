import type { MediaEngineRoomConnectParams } from '@syrnike13/platform'

import {
  disposeMediaEngineRemoteAudio,
  playMediaEngineRemoteAudioFrame,
  setMediaEngineRemoteAudioDeafened,
  stopMediaEngineRemoteAudio,
} from '#/features/voice/media-engine-remote-audio'
import { getSyrnikeDesktop } from '#/platform/runtime'

export type MediaEngineVoiceSession = {
  localUserId: string
  disconnect: () => Promise<void>
  setMicEnabled: (enabled: boolean) => Promise<void>
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
    setDeafened(value: boolean) {
      setMediaEngineRemoteAudioDeafened(value)
    },
    async disconnect() {
      unsubscribe()
      disposeMediaEngineRemoteAudio()
      await desktop.mediaEngine.roomDisconnect()
    },
  }
}
